/**
 * Phase 6 Block 4(b) — THE KILL TEST. Scripted, artifact-logged,
 * re-runnable proof that the chunked/resumable ETL runner (runEtl.ts,
 * Block 3/3.5) survives a `kill -9` mid-run and converges correctly, twice
 * over: once at an arbitrary/untimed point (Kill 1 — "does resume from the
 * persisted cursor work at all") and once precisely timed into the exact
 * race window Block 3.5's own note flagged — after `dispatchWrite` returns
 * ok and `recordChunkProgress` has persisted the cursor, but before the
 * next chunk's job is enqueued (Kill 2 — "does redelivery + persisted-
 * cursor-wins converge without silently losing or corrupting data").
 *
 * This script is self-contained and idempotent: every invocation drops and
 * re-seeds both the 1,000,000-row MySQL source table and the Postgres
 * scratch destination table from scratch, so running it twice in a row (the
 * spec's own re-runnability requirement) is just "invoke this twice" — no
 * state to reset by hand between runs, and no cross-run cruft accumulates
 * (grants/connections/workflow are found-or-created the same way every
 * other smoke script here does; only the two scratch tables are torn down
 * and rebuilt).
 *
 * Run with (from apps/worker/):
 *   npx tsx scripts/kill-test.ts
 * (reads apps/worker/.env via dotenv/config, same as env.ts — needs
 * SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/WRITE_DISPATCH_SIGNING_SECRET, plus
 * SUPABASE_ANON_KEY on process.env directly, same requirement as
 * write-smoke.ts, for the two-step grant RPCs which must go through a real
 * user JWT.)
 *
 * Prerequisites (not started by this script, same as the other smoke
 * scripts in this directory):
 *   - `supabase start`
 *   - `docker compose up -d --build redis dev-mysql dev-postgres
 *     connector-mysql connector-supabase`
 *
 * Optional env overrides (dev iteration only — never set these for the
 * actual delivered run, which must use the real 1,000,000-row default):
 *   KILL_TEST_ROWS         - row count (default 1_000_000)
 *   KILL_TEST_RACE_DELAY_MS - Kill 2's induced pause, ms (default 4000)
 *
 * This script runs on the HOST, so it reaches dev-mysql/dev-postgres via
 * their host-published ports (3307/5433) for seeding + verification; the
 * connector-mysql/connector-supabase CONTAINERS (driven indirectly, via the
 * worker's real dispatch path) reach the same databases over the
 * docker-compose network (dev-mysql:3306, dev-postgres:5432) — same
 * host-vs-container-network duality as every other script here (see
 * dispatch-smoke.ts's header comment for the full rationale). The worker
 * itself is spawned as a real, separate, `kill -9`-able child process (the
 * local tsx binary directly, no npx wrapper in between — same convention as
 * this repo's `next dev` invocation) rather than imported in-process,
 * because the whole point is proving survival of an actual process death.
 */
import "dotenv/config";
import { randomUUID, createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import pg from "pg";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { createClient } from "@supabase/supabase-js";
import { QUEUE_HEAVY, EtlRunJob, type GraphDoc } from "@nia/schemas";
import { grantStagedPostgresWriteRole } from "./lib/stagedWriteRole.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = path.resolve(__dirname, "..");

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY must be set (see this script's header comment).");
if (!ANON_KEY) throw new Error("SUPABASE_ANON_KEY must be set (see this script's header comment, e.g. copy from apps/web/.env.local).");

const ROW_COUNT = Number(process.env.KILL_TEST_ROWS ?? 1_000_000);
const RACE_DELAY_MS = Number(process.env.KILL_TEST_RACE_DELAY_MS ?? 4000);

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const DEMO_USER_ID = "00000000-0000-0000-0000-0000000000d1";
const DEMO_EMAIL = "demo@nia.dev";
const DEMO_PASSWORD = "password";

// Host-published ports — dialed by THIS script for seeding/verification.
const HOST_MYSQL = { host: "127.0.0.1", port: 3307, user: "root", password: "devroot", database: "sandbox" };
const HOST_PG = { host: "localhost", port: 5433, database: "sandbox", user: "postgres", password: "devroot" };
// Docker-compose service names — dialed by the connector-mysql/connector-supabase CONTAINERS.
const CONTAINER_MYSQL = { host: "dev-mysql", port: 3306, database: "sandbox" };
const CONTAINER_PG = { host: "dev-postgres", port: 5432, database: "sandbox" };

const SOURCE_TABLE = "kill_test_source";
const SCRATCH_TABLE = "kill_test_scratch";
const WRITE_ROLE_USER = "nia_kill_test_write";
const WRITE_ROLE_PASSWORD = "nia_kill_test_write_pw";

function log(msg: string, artifact: string[]): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  // eslint-disable-next-line no-console
  console.log(line);
  artifact.push(line);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Seeding: 1,000,000-row deterministic MySQL source table.
// ---------------------------------------------------------------------------

async function seedMysqlSource(rowCount: number, artifact: string[]): Promise<void> {
  const conn = await mysql.createConnection(HOST_MYSQL);
  try {
    await conn.query(`DROP TABLE IF EXISTS ${SOURCE_TABLE}`);
    await conn.query(`CREATE TABLE ${SOURCE_TABLE} (id INT PRIMARY KEY, content VARCHAR(64) NOT NULL)`);
    // sandbox.* is already granted SELECT to nia_ro at the database level
    // (docker/dev-mysql-init.sql) — a wildcard grant, so this new table is
    // readable by the source connection's credential with zero extra grant.
    const BATCH = 10_000;
    for (let start = 1; start <= rowCount; start += BATCH) {
      const end = Math.min(start + BATCH - 1, rowCount);
      const values: (number | string)[] = [];
      const placeholders: string[] = [];
      for (let id = start; id <= end; id++) {
        placeholders.push("(?, ?)");
        values.push(id, `row-${String(id).padStart(7, "0")}`);
      }
      await conn.query(`INSERT INTO ${SOURCE_TABLE} (id, content) VALUES ${placeholders.join(",")}`, values);
    }
    log(`Seeded ${rowCount} deterministic rows into mysql ${SOURCE_TABLE}.`, artifact);
  } finally {
    await conn.end();
  }
}

async function computeMysqlSourceChecksum(rowCount: number): Promise<string> {
  const conn = await mysql.createConnection(HOST_MYSQL);
  try {
    const hash = createHash("sha256");
    const BATCH = 50_000;
    let lastId = 0;
    let seen = 0;
    while (seen < rowCount) {
      const [rows] = await conn.query(`SELECT id, content FROM ${SOURCE_TABLE} WHERE id > ? ORDER BY id LIMIT ?`, [lastId, BATCH]);
      const batch = rows as Array<{ id: number; content: string }>;
      if (batch.length === 0) break;
      for (const row of batch) hash.update(`${row.id}:${row.content}\n`);
      lastId = batch[batch.length - 1]!.id;
      seen += batch.length;
    }
    return hash.digest("hex");
  } finally {
    await conn.end();
  }
}

async function dropMysqlSource(): Promise<void> {
  const conn = await mysql.createConnection(HOST_MYSQL);
  try {
    await conn.query(`DROP TABLE IF EXISTS ${SOURCE_TABLE}`);
  } finally {
    await conn.end();
  }
}

// ---------------------------------------------------------------------------
// Provisioning: Postgres scratch destination table + dedicated write role.
// Mirrors write-smoke.ts's provisionScratchTableAndRole/cleanup exactly.
// ---------------------------------------------------------------------------

async function provisionScratchTableAndRole(): Promise<void> {
  const client = new pg.Client(HOST_PG);
  await client.connect();
  try {
    await client.query(`DROP TABLE IF EXISTS ${SCRATCH_TABLE}`);
    await client.query(`CREATE TABLE ${SCRATCH_TABLE} (id integer primary key, content text not null)`);
    const { rowCount } = await client.query("select 1 from pg_roles where rolname = $1", [WRITE_ROLE_USER]);
    if (!rowCount) {
      await client.query(`create role ${WRITE_ROLE_USER} with login password '${WRITE_ROLE_PASSWORD}'`);
    }
    await client.query(`grant connect on database sandbox to ${WRITE_ROLE_USER}`);
    await client.query(`grant usage on schema public to ${WRITE_ROLE_USER}`);
    await client.query(`grant select, insert, update on ${SCRATCH_TABLE} to ${WRITE_ROLE_USER}`);
    // Runner defaults to staged writes (Phase 11) — grant what the staged
    // preflight requires beyond the destination table itself.
    await grantStagedPostgresWriteRole(client, "sandbox", WRITE_ROLE_USER);
  } finally {
    await client.end();
  }
}

async function countScratchRows(): Promise<number> {
  const client = new pg.Client(HOST_PG);
  await client.connect();
  try {
    const { rows } = await client.query(`select count(*)::int as n from ${SCRATCH_TABLE}`);
    return rows[0].n as number;
  } finally {
    await client.end();
  }
}

async function countScratchDuplicates(): Promise<number> {
  const client = new pg.Client(HOST_PG);
  await client.connect();
  try {
    const { rows } = await client.query(
      `select count(*)::int as n from (select id from ${SCRATCH_TABLE} group by id having count(*) > 1) dupes`,
    );
    return rows[0].n as number;
  } finally {
    await client.end();
  }
}

async function computeScratchChecksum(rowCount: number): Promise<string> {
  const client = new pg.Client(HOST_PG);
  await client.connect();
  try {
    const hash = createHash("sha256");
    const BATCH = 50_000;
    let lastId = 0;
    let seen = 0;
    while (seen < rowCount) {
      const { rows } = await client.query(`select id, content from ${SCRATCH_TABLE} where id > $1 order by id limit $2`, [lastId, BATCH]);
      if (rows.length === 0) break;
      for (const row of rows) hash.update(`${row.id}:${row.content}\n`);
      lastId = rows[rows.length - 1].id as number;
      seen += rows.length;
    }
    return hash.digest("hex");
  } finally {
    await client.end();
  }
}

async function cleanupScratchTableAndRole(): Promise<void> {
  const client = new pg.Client(HOST_PG);
  await client.connect();
  try {
    await client.query(`DROP TABLE IF EXISTS ${SCRATCH_TABLE}`);
    const { rowCount } = await client.query("select 1 from pg_roles where rolname = $1", [WRITE_ROLE_USER]);
    if (rowCount) {
      await client.query(`drop owned by ${WRITE_ROLE_USER}`);
      await client.query(`drop role if exists ${WRITE_ROLE_USER}`);
    }
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Org/connection/project/workflow/graph seeding — mirrors mapping-smoke.ts's
// find-or-create conventions exactly, with a source(mysql)->destination
// (supabase) graph whose destination is fully checks-green: entity set,
// mapping approved, upsertKeys chosen (grant confirmation is handled
// separately below, via RPC, per this phase's binding decision that no
// grant-creation UI exists yet).
// ---------------------------------------------------------------------------

async function getOrgId(): Promise<string> {
  const { data, error } = await supabaseAdmin.from("organizations").select("id").eq("slug", "icecream-co").single();
  if (error || !data) throw new Error(`Could not find seed.sql's demo org: ${error?.message}`);
  return data.id as string;
}

async function seedConnection(
  orgId: string,
  connectorId: "mysql" | "supabase",
  handle: string,
  displayName: string,
  config: Record<string, unknown>,
  readCred: { user: string; password: string },
): Promise<string> {
  const { count: installCount } = await supabaseAdmin
    .from("connector_installs")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("connector_id", connectorId);
  if (!installCount) {
    const { error } = await supabaseAdmin
      .from("connector_installs")
      .insert({ org_id: orgId, connector_id: connectorId, installed_by_user_id: DEMO_USER_ID });
    if (error) throw new Error(`install ${connectorId} failed: ${error.message}`);
  }

  const { data: existing } = await supabaseAdmin.from("connections").select("id").eq("org_id", orgId).eq("handle", handle).maybeSingle();
  if (existing) {
    await supabaseAdmin.from("connections").update({ config }).eq("id", existing.id as string);
    return existing.id as string;
  }

  const { data: vaultRef, error: vaultError } = await supabaseAdmin.rpc("create_connector_secret", { p_secret: readCred });
  if (vaultError || !vaultRef) throw new Error(`vault write for ${connectorId} failed: ${vaultError?.message}`);

  const { data, error } = await supabaseAdmin
    .from("connections")
    .insert({
      org_id: orgId,
      owner_id: null,
      connector_id: connectorId,
      handle,
      display_name: displayName,
      owner_user_id: DEMO_USER_ID,
      config,
      vault_secret_ref: vaultRef as string,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`connection insert for ${connectorId} failed: ${error?.message}`);
  return data.id as string;
}

async function seedWorkflow(orgId: string, sourceConnectionId: string, destConnectionId: string): Promise<string> {
  const { data: existingProject } = await supabaseAdmin
    .from("projects")
    .select("id")
    .eq("org_id", orgId)
    .eq("name", "Kill Test")
    .maybeSingle();
  const projectId =
    (existingProject?.id as string | undefined) ??
    (await supabaseAdmin.from("projects").insert({ org_id: orgId, name: "Kill Test", created_by: DEMO_USER_ID }).select("id").single())
      .data?.id;
  if (!projectId) throw new Error("Could not find or create the Kill Test project.");

  const { data: existingWorkflow } = await supabaseAdmin
    .from("workflows")
    .select("id")
    .eq("project_id", projectId)
    .eq("name", "mysql -> supabase kill test")
    .maybeSingle();
  const workflowId =
    (existingWorkflow?.id as string | undefined) ??
    (
      await supabaseAdmin
        .from("workflows")
        .insert({ project_id: projectId, org_id: orgId, name: "mysql -> supabase kill test", created_by: DEMO_USER_ID })
        .select("id")
        .single()
    ).data?.id;
  if (!workflowId) throw new Error("Could not find or create the kill-test workflow.");

  const graph: GraphDoc = {
    nodes: [
      {
        id: "src",
        type: "source",
        manifestId: "mysql",
        connectionId: sourceConnectionId,
        position: { x: 0, y: 0 },
        config: { operation: "read", entity: { namespace: "sandbox", name: SOURCE_TABLE } },
      },
      {
        id: "dest",
        type: "destination",
        manifestId: "supabase",
        connectionId: destConnectionId,
        position: { x: 200, y: 0 },
        config: {
          operation: "insert",
          entity: { namespace: "public", name: SCRATCH_TABLE },
          mapping: {
            version: 1,
            entries: [
              { from: "id", to: "id" },
              { from: "content", to: "content" },
            ],
            approvedAt: new Date().toISOString(),
          },
          upsertKeys: ["id"],
        },
      },
    ],
    edges: [{ id: "e1", source: "src", target: "dest" }],
  };

  const { error } = await supabaseAdmin.from("workflow_graphs").upsert({ workflow_id: workflowId, graph });
  if (error) throw new Error(`workflow_graphs upsert failed: ${error.message}`);

  return workflowId as string;
}

/**
 * Fresh write grant every invocation (create + confirm, never revoked here)
 * — mirrors write-smoke.ts's RPC pattern exactly. Per this phase's binding
 * decision, grant creation is driven directly via RPC for this script (no
 * grant-creation UI exists yet); the UI-visible downstream effects (verb
 * lock/unlock, checks going green) are proven separately by the E2E
 * Playwright test (Block 4 item a), not by this script.
 */
async function createAndConfirmWriteGrant(destConnectionId: string): Promise<string> {
  const { data: vaultRef, error: vaultError } = await supabaseAdmin.rpc("create_connector_secret", {
    p_secret: { user: WRITE_ROLE_USER, password: WRITE_ROLE_PASSWORD },
  });
  if (vaultError || !vaultRef) throw new Error(`vault write for write cred failed: ${vaultError?.message}`);

  const supabaseUser = createClient(SUPABASE_URL, ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signInError } = await supabaseUser.auth.signInWithPassword({ email: DEMO_EMAIL, password: DEMO_PASSWORD });
  if (signInError) throw new Error(`sign-in as demo user failed: ${signInError.message}`);

  const { data: grantRow, error: grantError } = await supabaseUser.rpc("create_write_grant", {
    p_connection_id: destConnectionId,
    // Staged writes (Phase 11 default) also touch the "nia" staging schema
    // — the grant scope has to cover it too, not just the destination
    // table's own schema.
    p_scope: { schemas: ["public", "nia"] },
  });
  if (grantError || !grantRow) throw new Error(`create_write_grant failed: ${grantError?.message}`);
  const grantId = (grantRow as { id: string }).id;

  const { error: confirmError } = await supabaseUser.rpc("confirm_write_grant", {
    p_grant_id: grantId,
    p_write_credential_vault_ref: vaultRef as string,
  });
  if (confirmError) throw new Error(`confirm_write_grant failed: ${confirmError.message}`);

  return grantId;
}

// ---------------------------------------------------------------------------
// BullMQ enqueue — mirrors apps/api/src/lib/runQueue.ts's enqueueEtlRun
// exactly (first chunk's jobId = runId).
// ---------------------------------------------------------------------------

async function enqueueFirstChunk(orgId: string, workflowId: string, runId: string): Promise<void> {
  const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue(QUEUE_HEAVY, { connection });
  try {
    await queue.add(
      "etl_run",
      EtlRunJob.parse({
        kind: "etl_run",
        scope: { orgId },
        workflowId,
        runId,
        nodeId: "dest",
        cursor: null,
        triggeredByUserId: DEMO_USER_ID,
      }),
      { jobId: runId },
    );
  } finally {
    await queue.close();
    await connection.quit();
  }
}

// ---------------------------------------------------------------------------
// Worker process lifecycle — a real, separately kill -9-able child process
// (local tsx binary directly, cwd apps/worker so its own dotenv/config picks
// up apps/worker/.env same as any other invocation).
// ---------------------------------------------------------------------------

function spawnWorker(raceDelayMs: number, artifact: string[]): Promise<ChildProcessWithoutNullStreams> {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(WORKER_DIR, "node_modules", ".bin", "tsx"), ["src/index.ts"], {
      cwd: WORKER_DIR,
      env: { ...process.env, ETL_KILL_TEST_RACE_DELAY_MS: raceDelayMs > 0 ? String(raceDelayMs) : "" },
      // detached so this child gets its own process group: tsx's CLI forks a
      // grandchild node process (the actual loader-registered `src/index.ts`
      // run) rather than exec-replacing itself, so killing just `child.pid`
      // leaves that grandchild running. Killing the whole group (negative
      // pid, below) is the only way to guarantee a real `kill -9` takes out
      // the actual worker.
      detached: true,
    });
    let resolved = false;
    const readyTimeout = setTimeout(() => {
      if (!resolved) reject(new Error("Worker did not print its ready line within 15s."));
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      log(`[worker stdout] ${text.trim()}`, artifact);
      if (!resolved && text.includes("Nia worker up")) {
        resolved = true;
        clearTimeout(readyTimeout);
        resolve(child);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => log(`[worker stderr] ${chunk.toString().trim()}`, artifact));
    child.on("error", (err) => {
      if (!resolved) {
        clearTimeout(readyTimeout);
        reject(err);
      }
    });
  });
}

// Kills the worker's entire process group (see the `detached: true` comment
// in spawnWorker) so tsx's grandchild loader process actually dies instead of
// being orphaned/reparented. Swallows ESRCH (group already gone).
function killWorkerGroup(worker: ChildProcessWithoutNullStreams): void {
  if (worker.pid === undefined) return;
  try {
    process.kill(-worker.pid, "SIGKILL");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
  });
}

// Module-level so the top-level main().catch() handler (an exception can
// interrupt any phase between a spawnWorker() and its matching
// killWorkerGroup()) can still reach in and kill whatever worker was live at
// the moment of failure. Without this, a worker orphaned mid-exception keeps
// running, and — since ioredis auto-reconnects — will silently resume
// pulling jobs the instant Redis/Supabase come back, corrupting whatever run
// starts next. Always kept in sync with the `worker` local in main().
let liveWorker: ChildProcessWithoutNullStreams | undefined;

async function spawnTrackedWorker(raceDelayMs: number, artifact: string[]): Promise<ChildProcessWithoutNullStreams> {
  const worker = await spawnWorker(raceDelayMs, artifact);
  liveWorker = worker;
  return worker;
}

function killTrackedWorker(worker: ChildProcessWithoutNullStreams): void {
  killWorkerGroup(worker);
  liveWorker = undefined;
}

type RunRow = { status: string; rows_processed: number; cursor_json: string | null };

async function readRunRow(runId: string): Promise<RunRow> {
  const { data, error } = await supabaseAdmin
    .from("workflow_runs")
    .select("status, rows_processed, cursor_json")
    .eq("id", runId)
    .maybeSingle();
  if (error) throw new Error(`readRunRow failed: ${error.message}`);
  return (data as RunRow | null) ?? { status: "pending", rows_processed: 0, cursor_json: null };
}

function isTerminalStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

/**
 * Polls workflow_runs until rows_processed crosses `threshold`, or the run
 * reaches a genuine terminal status, or timeoutMs elapses. Deliberately does
 * NOT bail out on readRunRow's "pending" fallback status (the row doesn't
 * exist yet until startRun's first-chunk upsert lands) — treating "not
 * created yet" as "stop waiting" would fire the kill instantly instead of
 * mid-run.
 */
async function waitForRowsAtLeast(runId: string, threshold: number, timeoutMs: number): Promise<RunRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await readRunRow(runId);
    if (row.rows_processed >= threshold || isTerminalStatus(row.status)) return row;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for rows_processed >= ${threshold} (last seen: ${JSON.stringify(row)}).`);
    await sleep(300);
  }
}

/** Polls until cursor_json changes from `baseline`, or the run reaches a genuine terminal status, or timeoutMs elapses — Kill 2's precise targeting. Same "pending" caveat as waitForRowsAtLeast. */
async function waitForCursorChange(runId: string, baseline: string | null, timeoutMs: number): Promise<RunRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await readRunRow(runId);
    if (row.cursor_json !== baseline || isTerminalStatus(row.status)) return row;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for cursor_json to change past ${JSON.stringify(baseline)}.`);
    await sleep(100);
  }
}

async function waitForTerminal(runId: string, timeoutMs: number): Promise<RunRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await readRunRow(runId);
    if (row.status === "succeeded" || row.status === "failed" || row.status === "cancelled") return row;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for run ${runId} to reach a terminal status (last seen: ${JSON.stringify(row)}).`);
    await sleep(500);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Module-level (not local to main()) so the top-level catch handler below can
// still write out everything logged so far — and where it failed — even if
// main() throws partway through. Per this block's own report requirement:
// "If the kill test FAILS, do not patch-and-rerun silently — report the
// failure mode with the artifact first."
const artifact: string[] = [];
const startedAt = new Date();
let artifactPath: string | null = null;

function flushArtifact(): void {
  const reportsDir = path.join(WORKER_DIR, "eval-reports");
  mkdirSync(reportsDir, { recursive: true });
  if (!artifactPath) artifactPath = path.join(reportsDir, `kill-test-${startedAt.toISOString().replace(/[:.]/g, "-")}.log`);
  writeFileSync(artifactPath, artifact.join("\n") + "\n");
}

async function main(): Promise<void> {
  log(`=== KILL TEST START (ROW_COUNT=${ROW_COUNT}, RACE_DELAY_MS=${RACE_DELAY_MS}) ===`, artifact);

  log("--- SEEDING ---", artifact);
  await seedMysqlSource(ROW_COUNT, artifact);
  const sourceChecksum = await computeMysqlSourceChecksum(ROW_COUNT);
  log(`Source checksum (sha256 over ordered id:content): ${sourceChecksum}`, artifact);

  await provisionScratchTableAndRole();
  log(`Provisioned empty destination scratch table ${SCRATCH_TABLE} + write role ${WRITE_ROLE_USER}.`, artifact);

  const orgId = await getOrgId();
  const sourceConnectionId = await seedConnection(orgId, "mysql", "@mysql-kill-test", "Kill test (mysql)", CONTAINER_MYSQL, {
    user: "nia_ro",
    password: "nia_ro_pw",
  });
  const destConnectionId = await seedConnection(orgId, "supabase", "@supabase-kill-test", "Kill test (supabase)", CONTAINER_PG, {
    user: "nia_ro",
    password: "nia_ro_pw",
  });
  const workflowId = await seedWorkflow(orgId, sourceConnectionId, destConnectionId);
  log(`Seeded workflow ${workflowId} (source ${sourceConnectionId} -> dest ${destConnectionId}).`, artifact);

  const grantId = await createAndConfirmWriteGrant(destConnectionId);
  log(`Created + confirmed write grant ${grantId} (scope: public).`, artifact);

  const runId = randomUUID();
  await enqueueFirstChunk(orgId, workflowId, runId);
  log(`Enqueued first chunk for run ${runId}.`, artifact);

  log("--- PHASE A: run until Kill 1 (untimed, natural, random point >= 10% of rows) ---", artifact);
  let worker = await spawnTrackedWorker(0, artifact);
  // The spec requires >=100k for the real 1,000,000-row run; that floor is
  // only meaningful (and only reachable in bounded time) at that scale — a
  // small KILL_TEST_ROWS override (dev-only mechanical validation of this
  // script itself, never used for the delivered run) scales the same
  // 15-50% fraction without the floor.
  const kill1Threshold =
    ROW_COUNT >= 200_000
      ? Math.max(100_000, Math.floor(ROW_COUNT * (0.15 + Math.random() * 0.35)))
      : Math.max(1, Math.floor(ROW_COUNT * (0.3 + Math.random() * 0.3)));
  log(`Kill 1 threshold chosen: rows_processed >= ${kill1Threshold}.`, artifact);
  const preKill1 = await waitForRowsAtLeast(runId, kill1Threshold, 30 * 60_000);
  const kill1At = new Date();
  killTrackedWorker(worker);
  await waitForExit(worker);
  log(
    `KILL 1 at ${kill1At.toISOString()} — observed rows_processed=${preKill1.rows_processed}, cursor_json=${preKill1.cursor_json}, status=${preKill1.status}.`,
    artifact,
  );

  log("--- PHASE B: restart (no delay), confirm resume progresses past Kill 1's point ---", artifact);
  worker = await spawnTrackedWorker(0, artifact);
  const resumeConfirmedAt = new Date();
  const postResume = await waitForRowsAtLeast(runId, preKill1.rows_processed + 1, 30 * 60_000);
  log(
    `RESUME confirmed at ${resumeConfirmedAt.toISOString()} — rows_processed advanced ${preKill1.rows_processed} -> ${postResume.rows_processed} after restart.`,
    artifact,
  );

  log(`--- PHASE C: restart with ETL_KILL_TEST_RACE_DELAY_MS=${RACE_DELAY_MS}, target Kill 2's exact race window ---`, artifact);
  killTrackedWorker(worker);
  await waitForExit(worker);
  const baselineRow = await readRunRow(runId);
  worker = await spawnTrackedWorker(RACE_DELAY_MS, artifact);
  // The first cursor_json change we observe after this restart is emitted by
  // recordChunkProgress() — i.e. exactly the "cursor persisted, next job not
  // yet enqueued" moment, since the induced delay sits immediately after
  // that write and before queue.add(). Killing the instant we see the
  // change lands squarely inside that window for the whole delay duration.
  const raceRow = await waitForCursorChange(runId, baselineRow.cursor_json, 30 * 60_000);
  const kill2At = new Date();
  killTrackedWorker(worker);
  await waitForExit(worker);
  log(
    `KILL 2 (targeted) at ${kill2At.toISOString()} — cursor_json had just changed to ${raceRow.cursor_json} (rows_processed=${raceRow.rows_processed}); killed inside the ${RACE_DELAY_MS}ms post-persist/pre-enqueue window.`,
    artifact,
  );

  log("--- PHASE D: restart (no delay), run to completion ---", artifact);
  worker = await spawnTrackedWorker(0, artifact);
  const finalRow = await waitForTerminal(runId, 60 * 60_000);
  killTrackedWorker(worker);
  await waitForExit(worker);
  log(`Run reached terminal status "${finalRow.status}" with rows_processed=${finalRow.rows_processed}.`, artifact);

  log("--- VERIFICATION ---", artifact);
  const destCount = await countScratchRows();
  const destChecksum = await computeScratchChecksum(ROW_COUNT);
  const dupeCount = await countScratchDuplicates();
  const replayCount = finalRow.rows_processed - ROW_COUNT;

  const countOk = destCount === ROW_COUNT;
  const checksumOk = destChecksum === sourceChecksum;
  const dupeOk = dupeCount === 0;
  const statusOk = finalRow.status === "succeeded";

  log(`Destination row count: ${destCount} (expected ${ROW_COUNT}) -> ${countOk ? "PASS" : "FAIL"}`, artifact);
  log(`Destination checksum:  ${destChecksum}`, artifact);
  log(`Source checksum:       ${sourceChecksum} -> ${checksumOk ? "PASS (match)" : "FAIL (mismatch)"}`, artifact);
  log(`Duplicate rows by upsert key (id): ${dupeCount} -> ${dupeOk ? "PASS" : "FAIL"}`, artifact);
  log(`Run status: ${finalRow.status} -> ${statusOk ? "PASS" : "FAIL"}`, artifact);
  log(`rows_processed on run row: ${finalRow.rows_processed}; observed replay count (rows_processed - ${ROW_COUNT}): ${replayCount}`, artifact);

  const allOk = countOk && checksumOk && dupeOk && statusOk;
  log(`\n=== ${allOk ? "KILL TEST PASSED" : "KILL TEST FAILED"} ===`, artifact);
  flushArtifact();
  // eslint-disable-next-line no-console
  console.log(`\nArtifact written to: ${artifactPath}`);

  if (allOk) {
    log("--- CLEANUP ---", artifact);
    await dropMysqlSource();
    await cleanupScratchTableAndRole();
    flushArtifact();
  } else {
    log("--- SKIPPING CLEANUP (failed run) — scratch/source tables left in place for inspection ---", artifact);
    flushArtifact();
  }

  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  // An exception between a spawnTrackedWorker() and its matching
  // killTrackedWorker() would otherwise leak the worker: it keeps running
  // (and, via ioredis auto-reconnect, keeps pulling jobs once Redis/Supabase
  // recover) and corrupts whatever kill-test invocation runs next.
  if (liveWorker) killTrackedWorker(liveWorker);
  log(`\n=== KILL TEST FAILED (exception) ===\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}`, artifact);
  log("--- SKIPPING CLEANUP (failed run) — scratch/source tables left in place for inspection ---", artifact);
  flushArtifact();
  console.error(err);
  console.error(`\nArtifact written to: ${artifactPath}`);
  process.exit(1);
});
