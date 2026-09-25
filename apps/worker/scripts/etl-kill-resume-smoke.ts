/**
 * Live smoke test for Phase 6 Block 3.5's checkpoint-soundness claim —
 * "Redis is transport, Postgres is checkpoint truth" — against real
 * infrastructure, NOT mocks. runEtl.test.ts already proves this branch in
 * isolation (mocked getRunCheckpoint/dispatch/dispatchWrite); this script
 * proves the real wiring: a real chunked run against the real mysql sandbox
 * source and a real Postgres destination (via connector-supabase), with a
 * simulated BullMQ stalled-job redelivery (the ORIGINAL job payload, with
 * its now-stale `cursor: null`, replayed a second time) — and asserts the
 * resumed chunk picks up from the *persisted* Postgres cursor, not from the
 * stale payload hint, without re-reading or re-writing any row twice.
 *
 * A literal "kill -9 the worker process" is exactly what Block 4 automates
 * (this script explicitly precedes and gates that work per the Block 3.5
 * spec) — this script simulates the same observable failure mode a
 * redelivered job actually produces (a job handler invoked twice with an
 * identical, now-outdated cursor field) without needing to orchestrate a
 * real child-process kill from within a single script.
 *
 * Run with (from apps/worker/):
 *   npx tsx scripts/etl-kill-resume-smoke.ts
 * (reads apps/worker/.env for SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/
 * CONNECTOR_DEV_HOST/REDIS_URL via dotenv/config, same as env.ts — runEtl
 * publishes real run events over the real Redis connection.)
 *
 * Prerequisites (not started by this script):
 *   - `supabase start` (applies migrations, incl. 0017's cursor_json column
 *     + 'cancelled' status, + seed.sql's demo org/user)
 *   - `docker compose up -d --build redis dev-mysql dev-postgres
 *     connector-mysql connector-supabase`
 *   - apps/web/.env.local (or supabase status) for SUPABASE_ANON_KEY, used
 *     to sign in as seed.sql's demo user for the write-grant RPCs (same
 *     requirement as write-smoke.ts).
 *
 * This script runs on the HOST: it reaches dev-mysql/dev-postgres via their
 * host-published ports (3307/5433) for direct seeding/verification via
 * `docker exec`/`pg`, while the connector-mysql/connector-supabase
 * CONTAINERS reach the same databases via compose service names
 * (dev-mysql:3306, dev-postgres:5432) through the connection rows' `config`
 * — same duality as dispatch-smoke.ts/write-smoke.ts.
 */
import { execFileSync } from "node:child_process";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import type { Queue } from "bullmq";
import type { EtlRunJob, GraphDoc } from "@nia/schemas";
import { runEtl } from "../src/lib/etl/runEtl.js";
import { getSecretStore } from "../src/lib/secretStore.js";
import { dbPool } from "../src/lib/dbPool.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY must be set (see this script's header comment).");
if (!ANON_KEY) throw new Error("SUPABASE_ANON_KEY must be set (see this script's header comment, e.g. copy from apps/web/.env.local).");

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DEMO_USER_ID = "00000000-0000-0000-0000-0000000000d1";
const DEMO_EMAIL = "demo@nia.dev";
const DEMO_PASSWORD = "password";

const MYSQL_CONTAINER = "nia-core-dev-mysql-1";
// Dialed by the connector-mysql CONTAINER, over the compose network.
const SOURCE_CONFIG = { host: "dev-mysql", port: 3306, database: "sandbox" };
// Dialed by the connector-supabase CONTAINER, over the compose network.
const DEST_CONFIG = { host: "dev-postgres", port: 5432, database: "sandbox" };
// Dialed by THIS script, from the host, for provisioning + verification.
const HOST_PG = { host: "localhost", port: 5433, database: "sandbox", user: "postgres", password: "devroot" };

const SCRATCH_TABLE = "etl_kill_resume_scratch";
const WRITE_ROLE_USER = "nia_etl_kill_resume";
const WRITE_ROLE_PASSWORD = "nia_etl_kill_resume_pw";

// ids >= 101 are this script's own scratch rows on top of dev-mysql-init.sql's
// 2 permanent seed rows (id 1, 2) — dispatch-smoke.ts asserts sandbox_items
// has exactly 2 rows, so these MUST be cleaned up before this script exits.
const EXTRA_IDS = [101, 102, 103, 104, 105, 106, 107, 108, 109];

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

function assert(label: string, cond: boolean, detail?: unknown): boolean {
  if (cond) {
    log(`  PASS  ${label}`);
  } else {
    log(`  FAIL  ${label} ${detail !== undefined ? JSON.stringify(detail) : ""}`);
  }
  return cond;
}

function mysqlExec(sql: string): void {
  execFileSync("docker", ["exec", MYSQL_CONTAINER, "mysql", "-uroot", "-pdevroot", "sandbox", "-e", sql]);
}

function seedExtraMysqlRows(): void {
  const values = EXTRA_IDS.map((id) => `(${id}, 'kr-${id}')`).join(", ");
  mysqlExec(`INSERT INTO sandbox_items (id, name) VALUES ${values} ON DUPLICATE KEY UPDATE name = VALUES(name);`);
}

function cleanupExtraMysqlRows(): void {
  mysqlExec(`DELETE FROM sandbox_items WHERE id >= 101;`);
}

async function provisionScratchTableAndRole(): Promise<void> {
  const client = new pg.Client(HOST_PG);
  await client.connect();
  try {
    await client.query(`drop table if exists ${SCRATCH_TABLE}`);
    await client.query(`create table ${SCRATCH_TABLE} (id int primary key, name text not null)`);
    const { rowCount } = await client.query("select 1 from pg_roles where rolname = $1", [WRITE_ROLE_USER]);
    if (!rowCount) {
      await client.query(`create role ${WRITE_ROLE_USER} with login password '${WRITE_ROLE_PASSWORD}'`);
    }
    await client.query(`grant connect on database sandbox to ${WRITE_ROLE_USER}`);
    await client.query(`grant usage on schema public to ${WRITE_ROLE_USER}`);
    await client.query(`grant select, insert, update on ${SCRATCH_TABLE} to ${WRITE_ROLE_USER}`);
  } finally {
    await client.end();
  }
}

async function readScratchRows(): Promise<Array<{ id: number; name: string }>> {
  const client = new pg.Client(HOST_PG);
  await client.connect();
  try {
    const { rows } = await client.query(`select id, name from ${SCRATCH_TABLE} order by id`);
    return rows as Array<{ id: number; name: string }>;
  } finally {
    await client.end();
  }
}

async function cleanupScratchTableAndRole(): Promise<void> {
  const client = new pg.Client(HOST_PG);
  await client.connect();
  try {
    await client.query(`drop table if exists ${SCRATCH_TABLE}`);
    const { rowCount } = await client.query("select 1 from pg_roles where rolname = $1", [WRITE_ROLE_USER]);
    if (rowCount) {
      await client.query(`drop owned by ${WRITE_ROLE_USER}`);
      await client.query(`drop role if exists ${WRITE_ROLE_USER}`);
    }
  } finally {
    await client.end();
  }
}

async function getOrgId(): Promise<string> {
  const { data, error } = await supabaseAdmin.from("organizations").select("id").eq("slug", "icecream-co").single();
  if (error || !data) throw new Error(`Could not find seed.sql's demo org: ${error?.message}`);
  return data.id as string;
}

async function seedConnection(orgId: string, connectorId: "mysql" | "supabase", config: Record<string, unknown>): Promise<string> {
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

  const handle = `@${connectorId}-etl-kill-resume`;
  const { data: existing } = await supabaseAdmin
    .from("connections")
    .select("id")
    .eq("org_id", orgId)
    .eq("handle", handle)
    .maybeSingle();
  if (existing) {
    const { error } = await supabaseAdmin.from("connections").update({ config }).eq("id", existing.id as string);
    if (error) throw new Error(`connection config update for ${connectorId} failed: ${error.message}`);
    return existing.id as string;
  }

  let vaultRef: string;
  try {
    vaultRef = await getSecretStore(dbPool).put({ user: "nia_ro", password: "nia_ro_pw" }, { orgId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`secret write for ${connectorId} failed: ${message}`);
  }

  const { data, error } = await supabaseAdmin
    .from("connections")
    .insert({
      org_id: orgId,
      owner_id: null,
      connector_id: connectorId,
      handle,
      display_name: `ETL kill-resume smoke (${connectorId})`,
      owner_user_id: DEMO_USER_ID,
      config,
      vault_secret_ref: vaultRef as string,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`connection insert for ${connectorId} failed: ${error?.message}`);
  return data.id as string;
}

async function seedWorkflowGraph(orgId: string, sourceConnId: string, destConnId: string): Promise<{ workflowId: string }> {
  const { data: existingProject } = await supabaseAdmin
    .from("projects")
    .select("id")
    .eq("org_id", orgId)
    .eq("name", "ETL kill-resume smoke")
    .maybeSingle();
  let projectId = existingProject?.id as string | undefined;
  if (!projectId) {
    const { data, error } = await supabaseAdmin
      .from("projects")
      .insert({ org_id: orgId, name: "ETL kill-resume smoke", created_by: DEMO_USER_ID })
      .select("id")
      .single();
    if (error || !data) throw new Error(`project insert failed: ${error?.message}`);
    projectId = data.id as string;
  }

  const { data: existingWorkflow } = await supabaseAdmin
    .from("workflows")
    .select("id")
    .eq("project_id", projectId)
    .eq("name", "ETL kill-resume smoke")
    .maybeSingle();
  let workflowId = existingWorkflow?.id as string | undefined;
  if (!workflowId) {
    const { data, error } = await supabaseAdmin
      .from("workflows")
      .insert({ project_id: projectId, org_id: orgId, name: "ETL kill-resume smoke", created_by: DEMO_USER_ID })
      .select("id")
      .single();
    if (error || !data) throw new Error(`workflow insert failed: ${error?.message}`);
    workflowId = data.id as string;
  }

  const graph: GraphDoc = {
    nodes: [
      {
        id: "src",
        type: "source",
        manifestId: "mysql",
        connectionId: sourceConnId,
        position: { x: 0, y: 0 },
        config: { operation: "read", entity: { namespace: "sandbox", name: "sandbox_items" } },
      },
      {
        id: "dest",
        type: "destination",
        manifestId: "supabase",
        connectionId: destConnId,
        position: { x: 200, y: 0 },
        config: {
          operation: "insert",
          entity: { namespace: "public", name: SCRATCH_TABLE },
          mapping: {
            version: 1,
            entries: [
              { from: "id", to: "id" },
              { from: "name", to: "name" },
            ],
            approvedAt: new Date().toISOString(),
          },
          upsertKeys: ["id"],
        },
      },
    ],
    edges: [{ id: "e0", source: "src", target: "dest" }],
  };

  const { error } = await supabaseAdmin.from("workflow_graphs").upsert({ workflow_id: workflowId, graph }, { onConflict: "workflow_id" });
  if (error) throw new Error(`workflow_graphs upsert failed: ${error.message}`);

  return { workflowId };
}

function queueStub(captured: EtlRunJob[]): Queue {
  return {
    add: async (_name: string, data: EtlRunJob) => {
      captured.push(data);
    },
  } as unknown as Queue;
}

async function main(): Promise<void> {
  let failures = 0;
  const track = (ok: boolean) => {
    if (!ok) failures++;
  };

  log("=== SEEDING (not part of the checkpoint-resume proof below) ===");
  seedExtraMysqlRows();
  await provisionScratchTableAndRole();
  const orgId = await getOrgId();
  const sourceConnId = await seedConnection(orgId, "mysql", SOURCE_CONFIG);
  const destConnId = await seedConnection(orgId, "supabase", DEST_CONFIG);
  log(`Seeded connections: source=${sourceConnId} dest=${destConnId}`);

  const writeVaultRef = await (async () => {
    try {
      return await getSecretStore(dbPool).put({ user: WRITE_ROLE_USER, password: WRITE_ROLE_PASSWORD }, { orgId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`secret write for write cred failed: ${message}`);
    }
  })();

  const supabaseUser = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signInError } = await supabaseUser.auth.signInWithPassword({ email: DEMO_EMAIL, password: DEMO_PASSWORD });
  if (signInError) throw new Error(`sign-in as demo user failed: ${signInError.message}`);

  const { data: grantRow, error: grantError } = await supabaseUser.rpc("create_write_grant", {
    p_connection_id: destConnId,
    p_scope: { schemas: ["public"] },
  });
  if (grantError || !grantRow) throw new Error(`create_write_grant failed: ${grantError?.message}`);
  const grantId = (grantRow as { id: string }).id;

  const { error: confirmError } = await supabaseUser.rpc("confirm_write_grant", {
    p_grant_id: grantId,
    p_write_credential_vault_ref: writeVaultRef,
  });
  if (confirmError) throw new Error(`confirm_write_grant failed: ${confirmError.message}`);
  log(`Confirmed write grant: ${grantId}`);

  const { workflowId } = await seedWorkflowGraph(orgId, sourceConnId, destConnId);
  log(`Seeded workflow: ${workflowId}`);

  log("\n=== ASSERTIONS: runEtl() checkpoint-resume against real infra ===");

  const { data: runRow, error: runInsertError } = await supabaseAdmin
    .from("workflow_runs")
    .insert({ workflow_id: workflowId, org_id: orgId, status: "running", rows_processed: 0 })
    .select("id")
    .single();
  if (runInsertError || !runRow) throw new Error(`workflow_runs seed insert failed: ${runInsertError?.message}`);
  const runId = runRow.id as string;

  const originalJob: EtlRunJob = {
    kind: "etl_run",
    orgId,
    workflowId,
    runId,
    nodeId: "dest",
    cursor: null,
    chunkSize: 4,
    triggeredByUserId: DEMO_USER_ID,
  };

  // --- Chunk 1: real first chunk. 11 total source rows (1,2,101..109) sorted
  // by id ascending -> first 4 are [1,2,101,102]. ---
  const captured1: EtlRunJob[] = [];
  const r1 = await runEtl(originalJob, queueStub(captured1));
  track(assert("chunk 1: status 'chunk'", r1.status === "chunk", r1));
  track(assert("chunk 1: nextCursor is 102 (last of [1,2,101,102])", r1.nextCursor === 102, r1));
  const rowsAfter1 = await readScratchRows();
  track(assert("chunk 1: 4 rows written", rowsAfter1.length === 4, rowsAfter1));

  // --- Simulate a lost/never-delivered next-job message after a crash: the
  // real next job captured1[0] (cursor: "102") is discarded, never driven. ---
  log("  (simulating crash: discarding the real next-chunk job, never enqueuing it)");

  // --- "Redelivery": BullMQ redelivers the ORIGINAL job, with its now-stale
  // cursor: null. If the runner trusted this payload cursor, it would
  // restart from the beginning and return nextCursor: 102 again. Postgres's
  // persisted checkpoint (cursor_json = '{"lastKey":102}') must win instead. ---
  const captured2: EtlRunJob[] = [];
  const r2 = await runEtl(originalJob, queueStub(captured2));
  track(
    assert(
      "redelivered chunk: nextCursor is 106, NOT 102 again — proves Postgres checkpoint wins over the stale payload cursor",
      r2.nextCursor === 106,
      r2,
    ),
  );
  const rowsAfter2 = await readScratchRows();
  track(assert("redelivered chunk: 8 rows total (no re-write of chunk 1's rows)", rowsAfter2.length === 8, rowsAfter2));
  track(
    assert(
      "redelivered chunk: no duplicate ids across the 8 rows",
      new Set(rowsAfter2.map((r) => r.id)).size === 8,
      rowsAfter2,
    ),
  );

  // --- Chunk 3: drive the REAL next job returned by the redelivered call
  // (cursor: "106") to completion. ---
  const job3 = captured2[captured2.length - 1];
  if (!job3) throw new Error("expected runEtl to have enqueued a next job after the redelivered chunk");
  const captured3: EtlRunJob[] = [];
  const r3 = await runEtl(job3, queueStub(captured3));
  track(assert("chunk 3: status 'done'", r3.status === "done", r3));
  const rowsFinal = await readScratchRows();
  track(assert("final: 11 rows total", rowsFinal.length === 11, rowsFinal));
  track(assert("final: no duplicate ids", new Set(rowsFinal.map((r) => r.id)).size === 11, rowsFinal));
  const expectedIds = [1, 2, ...EXTRA_IDS].sort((a, b) => a - b);
  track(assert("final: ids match all source rows exactly", JSON.stringify(rowsFinal.map((r) => r.id)) === JSON.stringify(expectedIds), rowsFinal));

  const { data: finalRun, error: finalRunError } = await supabaseAdmin
    .from("workflow_runs")
    .select("status, rows_processed")
    .eq("id", runId)
    .single();
  if (finalRunError || !finalRun) throw new Error(`workflow_runs final read failed: ${finalRunError?.message}`);
  track(assert("workflow_runs.status: succeeded", finalRun.status === "succeeded", finalRun));
  track(assert("workflow_runs.rows_processed: 11 (4 + 4 + 3, no double-count)", finalRun.rows_processed === 11, finalRun));

  log("\n=== CLEANUP ===");
  cleanupExtraMysqlRows();
  await cleanupScratchTableAndRole();
  log("Deleted extra sandbox_items rows, dropped scratch table + write role.");

  log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  try {
    cleanupExtraMysqlRows();
  } catch {
    // best-effort cleanup on failure
  }
  try {
    await cleanupScratchTableAndRole();
  } catch {
    // best-effort cleanup on failure
  }
  process.exit(1);
});
