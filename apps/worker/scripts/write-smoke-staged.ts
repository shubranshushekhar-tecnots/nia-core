/**
 * Live smoke test for Phase 11's staged write path (staging table, atomic
 * apply with post-assertions, quarantine sink) against real infrastructure
 * — NOT mocks. runEtl.test.ts/stagedWrite's own unit coverage and the
 * connector-level /stage route tests (index.test.ts, incl. the
 * signed-context tampering tests) already prove this logic in isolation;
 * this script proves the real wiring: a real chunked runEtl() driving a
 * real mysql sandbox source, a real connector-supabase container's /stage
 * + /write + /preflight routes, and a real docker-compose sandbox Postgres
 * (dev-postgres) as the staged destination.
 *
 * Three scenarios, run in this exact order (scenario 3 temporarily mutates
 * shared sandbox_items rows, so it must run last):
 *   1. happy path       — full staged run completes: preflight, create
 *      staging, per-chunk write, apply (assertions pass), drop staging.
 *   2. assertion failure — a NULL value in a nullable, non-PK upsertKeys
 *      column trips the always-on `noNullKeys` assertion at apply time:
 *      the run fails cleanly, staging is dropped, the destination table is
 *      never touched (apply happens inside a transaction that only
 *      commits after every assertion passes).
 *   3. kill-after-chunk-1-resume — mirrors etl-kill-resume-smoke.ts's
 *      redelivery technique (a stale, already-superseded `cursor: null`
 *      job replayed a second time) but for staged mode: proves rows land
 *      in the STAGING table across chunks (never the real destination),
 *      the persisted Postgres checkpoint wins over the stale payload on
 *      redelivery (ensureStaging's idempotent create/register makes this
 *      safe to redo), and only the final chunk's apply atomically moves
 *      every row into the real destination.
 *
 * Run with (from apps/worker/):
 *   npx tsx scripts/write-smoke-staged.ts
 * (reads apps/worker/.env for SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/
 * WRITE_DISPATCH_SIGNING_SECRET/CONNECTOR_DEV_HOST/REDIS_URL via
 * dotenv/config, same as env.ts.)
 *
 * Prerequisites (not started by this script):
 *   - `supabase start` (applies migrations, incl. 0021/0022's
 *     staging_objects table)
 *   - `redis`/`dev-mysql`/`dev-postgres`/`connector-mysql`/
 *     `connector-supabase` are rebuilt+started automatically by
 *     `pnpm run smoke:staged`'s `presmoke:staged` step (`docker compose up
 *     -d --build ...`) — always a fresh connector image, never a stale one
 *     silently serving old signature-verification logic (see
 *     docs/decisions.md's Phase 11 "stale image" lesson).
 *   - apps/web/.env.local (or supabase status) for SUPABASE_ANON_KEY, used
 *     to sign in as seed.sql's demo user for the write-grant RPCs (same
 *     requirement as write-smoke.ts/etl-kill-resume-smoke.ts).
 *
 * This script runs on the HOST: it reaches dev-mysql/dev-postgres via
 * their host-published ports (3307/5433) for direct seeding/verification,
 * while the connector-mysql/connector-supabase CONTAINERS reach the same
 * databases via compose service names (dev-mysql:3306, dev-postgres:5432)
 * through the connection rows' `config` — same duality as
 * write-smoke.ts/etl-kill-resume-smoke.ts.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import type { Queue } from "bullmq";
import type { EtlRunJob, GraphDoc } from "@nia/schemas";
import { runEtl } from "../src/lib/etl/runEtl.js";
import type { WorkspaceScope } from "../src/lib/workspaceScope.js";

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

const WRITE_ROLE_USER = "nia_write_smoke_staged";
const WRITE_ROLE_PASSWORD = "nia_write_smoke_staged_pw";

const DEST_HAPPY = "write_smoke_staged_happy";
const DEST_ASSERTFAIL = "write_smoke_staged_assertfail";
const DEST_KILLRESUME = "write_smoke_staged_killresume";
const MYSQL_ASSERTFAIL_SRC = "write_smoke_staged_assertfail_src";

// ids >= 201 are this script's own scratch rows on top of dev-mysql-init.sql's
// 2 permanent seed rows (id 1, 2) — a disjoint range from
// etl-kill-resume-smoke.ts's 101..109, so both scripts stay independently
// safe to run. Cleaned up before this script exits (dispatch-smoke.ts
// asserts sandbox_items has exactly 2 rows).
const EXTRA_IDS = [201, 202, 203, 204, 205, 206, 207, 208, 209];

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

/** Mirrors stagingRegistry.ts's deriveStagingEntity exactly, so this script can read the staging table directly without a registry round-trip. */
function stagingTableName(runId: string): string {
  const hash = createHash("sha256").update(runId).digest("hex").slice(0, 16);
  return `nia_stg_${hash}`;
}

async function withHostPg<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client(HOST_PG);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function tableExists(schema: string, table: string): Promise<boolean> {
  return withHostPg(async (client) => {
    const { rows } = await client.query(
      "select 1 from information_schema.tables where table_schema = $1 and table_name = $2",
      [schema, table],
    );
    return rows.length > 0;
  });
}

async function readRows(table: string, orderBy: string): Promise<Record<string, unknown>[]> {
  return withHostPg(async (client) => {
    const { rows } = await client.query(`select * from ${table} order by ${orderBy}`);
    return rows as Record<string, unknown>[];
  });
}

async function provisionRoleAndTables(): Promise<void> {
  await withHostPg(async (client) => {
    for (const table of [DEST_HAPPY, DEST_ASSERTFAIL, DEST_KILLRESUME]) {
      await client.query(`drop table if exists ${table}`);
    }
    await client.query(`create table ${DEST_HAPPY} (id int primary key, name text not null)`);
    // code is unique (not just indexed) so the staging table's `LIKE ...
    // INCLUDING INDEXES` inherits a real unique constraint to drive the
    // per-chunk staging upsert's `ON CONFLICT (code)` — Postgres still
    // permits multiple NULLs in a UNIQUE column, so this preserves the
    // scenario's actual test: a NULL `code` value should trip the
    // noNullKeys assertion at apply time, not fail earlier at staging-write time.
    await client.query(`create table ${DEST_ASSERTFAIL} (row_num int primary key, code text unique, name text not null)`);
    await client.query(`create table ${DEST_KILLRESUME} (id int primary key, name text not null)`);

    const { rowCount } = await client.query("select 1 from pg_roles where rolname = $1", [WRITE_ROLE_USER]);
    if (!rowCount) {
      await client.query(`create role ${WRITE_ROLE_USER} with login password '${WRITE_ROLE_PASSWORD}'`);
    }
    await client.query(`grant connect on database sandbox to ${WRITE_ROLE_USER}`);
    // Staged writes create a dedicated "nia" schema on first use
    // (stagingSql.ts's buildCreateStagingSql) — needs CREATE on the
    // database itself, per /preflight's own create-schema-nia check.
    await client.query(`grant create on database sandbox to ${WRITE_ROLE_USER}`);
    await client.query(`grant usage on schema public to ${WRITE_ROLE_USER}`);
    for (const table of [DEST_HAPPY, DEST_ASSERTFAIL, DEST_KILLRESUME]) {
      await client.query(`grant select, insert, update on ${table} to ${WRITE_ROLE_USER}`);
    }
  });
  mysqlExec(`DROP TABLE IF EXISTS ${MYSQL_ASSERTFAIL_SRC};`);
  mysqlExec(`
    CREATE TABLE ${MYSQL_ASSERTFAIL_SRC} (
      row_num INT PRIMARY KEY,
      code VARCHAR(50) NULL,
      name VARCHAR(50) NOT NULL
    );
  `);
  mysqlExec(
    `INSERT INTO ${MYSQL_ASSERTFAIL_SRC} (row_num, code, name) VALUES (1, 'a', 'Alpha'), (2, NULL, 'Beta'), (3, 'c', 'Gamma');`,
  );
}

async function cleanup(): Promise<void> {
  await withHostPg(async (client) => {
    for (const table of [DEST_HAPPY, DEST_ASSERTFAIL, DEST_KILLRESUME]) {
      await client.query(`drop table if exists ${table}`);
    }
    const { rowCount } = await client.query("select 1 from pg_roles where rolname = $1", [WRITE_ROLE_USER]);
    if (rowCount) {
      // Also drops the "nia" schema and anything left in it (owned by this
      // role once it creates it) — any staging/quarantine table a failed
      // run left behind gets swept up here too.
      await client.query(`drop owned by ${WRITE_ROLE_USER}`);
      await client.query(`drop role if exists ${WRITE_ROLE_USER}`);
    }
  });
  mysqlExec(`DROP TABLE IF EXISTS ${MYSQL_ASSERTFAIL_SRC};`);
  mysqlExec(`DELETE FROM sandbox_items WHERE id >= 201;`);
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

  const handle = `@${connectorId}-write-smoke-staged`;
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

  const { data: vaultRef, error: vaultError } = await supabaseAdmin.rpc("create_connector_secret", {
    p_secret: { user: "nia_ro", password: "nia_ro_pw" },
  });
  if (vaultError || !vaultRef) throw new Error(`vault write for ${connectorId} failed: ${vaultError?.message}`);

  const { data, error } = await supabaseAdmin
    .from("connections")
    .insert({
      org_id: orgId,
      owner_id: null,
      connector_id: connectorId,
      handle,
      display_name: `Write smoke staged (${connectorId})`,
      owner_user_id: DEMO_USER_ID,
      config,
      vault_secret_ref: vaultRef as string,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`connection insert for ${connectorId} failed: ${error?.message}`);
  return data.id as string;
}

async function seedWorkflowGraph(
  orgId: string,
  sourceConnId: string,
  destConnId: string,
  workflowName: string,
  sourceEntity: { namespace: string; name: string },
  destEntity: { namespace: string; name: string },
  mappingEntries: { from: string; to: string }[],
  upsertKeys: string[],
): Promise<{ workflowId: string }> {
  const { data: existingProject } = await supabaseAdmin
    .from("projects")
    .select("id")
    .eq("org_id", orgId)
    .eq("name", "Write smoke staged")
    .maybeSingle();
  let projectId = existingProject?.id as string | undefined;
  if (!projectId) {
    const { data, error } = await supabaseAdmin
      .from("projects")
      .insert({ org_id: orgId, name: "Write smoke staged", created_by: DEMO_USER_ID })
      .select("id")
      .single();
    if (error || !data) throw new Error(`project insert failed: ${error?.message}`);
    projectId = data.id as string;
  }

  const { data: existingWorkflow } = await supabaseAdmin
    .from("workflows")
    .select("id")
    .eq("project_id", projectId)
    .eq("name", workflowName)
    .maybeSingle();
  let workflowId = existingWorkflow?.id as string | undefined;
  if (!workflowId) {
    const { data, error } = await supabaseAdmin
      .from("workflows")
      .insert({ project_id: projectId, org_id: orgId, name: workflowName, created_by: DEMO_USER_ID })
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
        config: { operation: "read", entity: sourceEntity },
      },
      {
        id: "dest",
        type: "destination",
        manifestId: "supabase",
        connectionId: destConnId,
        position: { x: 200, y: 0 },
        config: {
          operation: "insert",
          entity: destEntity,
          mapping: { version: 1, entries: mappingEntries, approvedAt: new Date().toISOString() },
          upsertKeys,
          // writeMode deliberately absent — defaults to "staged"
          // (resolveWriteMode, nodeConfig.ts), the whole point of this
          // script.
        },
      },
    ],
    edges: [{ id: "e0", source: "src", target: "dest" }],
  };

  const { error } = await supabaseAdmin.from("workflow_graphs").upsert({ workflow_id: workflowId, graph }, { onConflict: "workflow_id" });
  if (error) throw new Error(`workflow_graphs upsert failed: ${error.message}`);

  return { workflowId };
}

async function createRun(workflowId: string, orgId: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("workflow_runs")
    .insert({ workflow_id: workflowId, org_id: orgId, status: "running", rows_processed: 0 })
    .select("id")
    .single();
  if (error || !data) throw new Error(`workflow_runs seed insert failed: ${error?.message}`);
  return data.id as string;
}

function queueStub(captured: EtlRunJob[]): Queue {
  return {
    add: async (_name: string, data: EtlRunJob) => {
      captured.push(data);
    },
  } as unknown as Queue;
}

async function getRunStatus(runId: string): Promise<{ status: string; rows_processed: number }> {
  const { data, error } = await supabaseAdmin
    .from("workflow_runs")
    .select("status, rows_processed")
    .eq("id", runId)
    .single();
  if (error || !data) throw new Error(`workflow_runs read failed: ${error?.message}`);
  return data as { status: string; rows_processed: number };
}

async function getStagingObjectStatus(runId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("staging_objects")
    .select("status")
    .eq("run_id", runId)
    .eq("kind", "staging")
    .maybeSingle();
  return (data?.status as string | undefined) ?? null;
}

async function main(): Promise<void> {
  let failures = 0;
  const track = (ok: boolean) => {
    if (!ok) failures++;
  };

  log("=== SEEDING (not part of the staged-write proof below) ===");
  await provisionRoleAndTables();
  const orgId = await getOrgId();
  const scope: WorkspaceScope = { orgId };
  const sourceConnId = await seedConnection(orgId, "mysql", SOURCE_CONFIG);
  const destConnId = await seedConnection(orgId, "supabase", DEST_CONFIG);
  log(`Seeded connections: source=${sourceConnId} dest=${destConnId}`);

  const writeVaultRef = await (async () => {
    const { data, error } = await supabaseAdmin.rpc("create_connector_secret", {
      p_secret: { user: WRITE_ROLE_USER, password: WRITE_ROLE_PASSWORD },
    });
    if (error || !data) throw new Error(`vault write for write cred failed: ${error?.message}`);
    return data as string;
  })();

  // create_write_grant/confirm_write_grant are SECURITY DEFINER and derive
  // their actor from auth.uid() — must go through a real user JWT, not the
  // service-role client.
  const supabaseUser = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signInError } = await supabaseUser.auth.signInWithPassword({ email: DEMO_EMAIL, password: DEMO_PASSWORD });
  if (signInError) throw new Error(`sign-in as demo user failed: ${signInError.message}`);

  const { data: grantRow, error: grantError } = await supabaseUser.rpc("create_write_grant", {
    p_connection_id: destConnId,
    p_scope: { schemas: ["public", "nia"] },
  });
  if (grantError || !grantRow) throw new Error(`create_write_grant failed: ${grantError?.message}`);
  const grantId = (grantRow as { id: string }).id;

  const { error: confirmError } = await supabaseUser.rpc("confirm_write_grant", {
    p_grant_id: grantId,
    p_write_credential_vault_ref: writeVaultRef,
  });
  if (confirmError) throw new Error(`confirm_write_grant failed: ${confirmError.message}`);
  log(`Confirmed write grant: ${grantId}`);

  // =====================================================================
  // Scenario 1: happy path
  // =====================================================================
  log("\n=== SCENARIO 1: happy path (full staged run: create, write, apply, drop) ===");
  {
    const { workflowId } = await seedWorkflowGraph(
      orgId,
      sourceConnId,
      destConnId,
      "Write smoke staged - happy",
      { namespace: "sandbox", name: "sandbox_items" },
      { namespace: "public", name: DEST_HAPPY },
      [
        { from: "id", to: "id" },
        { from: "name", to: "name" },
      ],
      ["id"],
    );
    const runId = await createRun(workflowId, orgId);
    const job: EtlRunJob = {
      kind: "etl_run",
      scope,
      workflowId,
      runId,
      nodeId: "dest",
      cursor: null,
      chunkSize: 10, // only 2 baseline rows exist right now -> single chunk
      triggeredByUserId: DEMO_USER_ID,
    };

    const result = await runEtl(job, queueStub([]));
    track(assert("status 'done'", result.status === "done", result));

    const stagingExists = await tableExists("nia", stagingTableName(runId));
    track(assert("staging table dropped after successful apply", !stagingExists));

    const rows = await readRows(DEST_HAPPY, "id");
    track(
      assert(
        "destination has the 2 baseline source rows, atomically applied",
        JSON.stringify(rows) === JSON.stringify([
          { id: 1, name: "seed-1" },
          { id: 2, name: "seed-2" },
        ]),
        rows,
      ),
    );

    const run = await getRunStatus(runId);
    track(assert("workflow_runs.status: succeeded", run.status === "succeeded", run));
    track(assert("workflow_runs.rows_processed: 2", run.rows_processed === 2, run));

    const registryStatus = await getStagingObjectStatus(runId);
    track(assert("staging_objects row marked 'dropped'", registryStatus === "dropped", registryStatus));
  }

  // =====================================================================
  // Scenario 2: assertion failure
  // =====================================================================
  log("\n=== SCENARIO 2: assertion failure (NULL upsert-key trips noNullKeys at apply) ===");
  {
    const { workflowId } = await seedWorkflowGraph(
      orgId,
      sourceConnId,
      destConnId,
      "Write smoke staged - assertfail",
      { namespace: "sandbox", name: MYSQL_ASSERTFAIL_SRC },
      { namespace: "public", name: DEST_ASSERTFAIL },
      [
        { from: "row_num", to: "row_num" },
        { from: "code", to: "code" },
        { from: "name", to: "name" },
      ],
      ["code"],
    );
    const runId = await createRun(workflowId, orgId);
    const job: EtlRunJob = {
      kind: "etl_run",
      scope,
      workflowId,
      runId,
      nodeId: "dest",
      cursor: null,
      chunkSize: 10, // only 3 source rows -> single chunk
      triggeredByUserId: DEMO_USER_ID,
    };

    const result = await runEtl(job, queueStub([]));
    track(assert("status 'failed'", result.status === "failed", result));
    track(assert("message names the failed assertion", /Staging assertions failed/.test(result.message ?? ""), result));
    track(assert("message names noNullKeys", /noNullKeys/.test(result.message ?? ""), result));

    const stagingExists = await tableExists("nia", stagingTableName(runId));
    track(assert("staging table dropped after the failed apply (best-effort cleanup)", !stagingExists));

    const rows = await readRows(DEST_ASSERTFAIL, "row_num");
    track(assert("destination was never touched — the failing apply rolled back before any INSERT", rows.length === 0, rows));

    const run = await getRunStatus(runId);
    track(assert("workflow_runs.status: failed", run.status === "failed", run));

    const registryStatus = await getStagingObjectStatus(runId);
    track(assert("staging_objects row marked 'dropped' even on failure", registryStatus === "dropped", registryStatus));
  }

  // =====================================================================
  // Scenario 3: kill-after-chunk-1-resume
  // =====================================================================
  log("\n=== SCENARIO 3: kill-after-chunk-1-resume (staged mode) ===");
  {
    mysqlExec(
      `INSERT INTO sandbox_items (id, name) VALUES ${EXTRA_IDS.map((id) => `(${id}, 'kr-${id}')`).join(", ")} ON DUPLICATE KEY UPDATE name = VALUES(name);`,
    );

    const { workflowId } = await seedWorkflowGraph(
      orgId,
      sourceConnId,
      destConnId,
      "Write smoke staged - killresume",
      { namespace: "sandbox", name: "sandbox_items" },
      { namespace: "public", name: DEST_KILLRESUME },
      [
        { from: "id", to: "id" },
        { from: "name", to: "name" },
      ],
      ["id"],
    );
    const runId = await createRun(workflowId, orgId);
    const stagingName = stagingTableName(runId);
    const originalJob: EtlRunJob = {
      kind: "etl_run",
      scope,
      workflowId,
      runId,
      nodeId: "dest",
      cursor: null,
      chunkSize: 4,
      triggeredByUserId: DEMO_USER_ID,
    };

    // --- Chunk 1: real first chunk. 11 total source rows (1,2,201..209)
    // sorted by id ascending -> first 4 are [1,2,201,202]. ---
    const captured1: EtlRunJob[] = [];
    const r1 = await runEtl(originalJob, queueStub(captured1));
    track(assert("chunk 1: status 'chunk'", r1.status === "chunk", r1));
    track(assert("chunk 1: nextCursor is 202 (last of [1,2,201,202])", r1.nextCursor === 202, r1));

    const stagingAfter1 = await readRows(`nia.${stagingName}`, "id");
    track(assert("chunk 1: 4 rows landed in the STAGING table", stagingAfter1.length === 4, stagingAfter1));
    const destAfter1 = await readRows(DEST_KILLRESUME, "id");
    track(assert("chunk 1: destination table untouched (still 0 rows, not applied yet)", destAfter1.length === 0, destAfter1));

    // --- Simulate a lost/never-delivered next-job message after a crash:
    // the real next job captured1[0] (cursor: "202") is discarded. ---
    log("  (simulating crash: discarding the real next-chunk job, never enqueuing it)");

    // --- "Redelivery": BullMQ redelivers the ORIGINAL job, with its now-
    // stale cursor: null. ensureStaging's idempotent create+register makes
    // it safe to run again; Postgres's persisted checkpoint
    // (cursor_json = '{"lastKey":202}') must still win over the stale
    // payload cursor. ---
    const captured2: EtlRunJob[] = [];
    const r2 = await runEtl(originalJob, queueStub(captured2));
    track(
      assert(
        "redelivered chunk: nextCursor is 206, NOT 202 again — Postgres checkpoint wins over the stale payload cursor",
        r2.nextCursor === 206,
        r2,
      ),
    );
    const stagingAfter2 = await readRows(`nia.${stagingName}`, "id");
    track(assert("redelivered chunk: 8 rows total in STAGING (no re-write of chunk 1's rows)", stagingAfter2.length === 8, stagingAfter2));
    track(
      assert(
        "redelivered chunk: no duplicate ids in staging",
        new Set(stagingAfter2.map((r) => r.id)).size === 8,
        stagingAfter2,
      ),
    );
    const destAfter2 = await readRows(DEST_KILLRESUME, "id");
    track(assert("redelivered chunk: destination still untouched (not the last chunk yet)", destAfter2.length === 0, destAfter2));

    // --- Chunk 3: drive the REAL next job returned by the redelivered call
    // (cursor: "206") to completion. ---
    const job3 = captured2[captured2.length - 1];
    if (!job3) throw new Error("expected runEtl to have enqueued a next job after the redelivered chunk");
    const r3 = await runEtl(job3, queueStub([]));
    track(assert("chunk 3: status 'done'", r3.status === "done", r3));

    const stagingExists = await tableExists("nia", stagingName);
    track(assert("staging table dropped after the final apply", !stagingExists));

    const destFinal = await readRows(DEST_KILLRESUME, "id");
    track(assert("final: 11 rows total, atomically applied in one shot", destFinal.length === 11, destFinal));
    track(assert("final: no duplicate ids", new Set(destFinal.map((r) => r.id)).size === 11, destFinal));
    const expectedIds = [1, 2, ...EXTRA_IDS].sort((a, b) => a - b);
    track(
      assert(
        "final: ids match all source rows exactly",
        JSON.stringify(destFinal.map((r) => r.id)) === JSON.stringify(expectedIds),
        destFinal,
      ),
    );

    const run = await getRunStatus(runId);
    track(assert("workflow_runs.status: succeeded", run.status === "succeeded", run));
    track(assert("workflow_runs.rows_processed: 11 (4 + 4 + 3, no double-count)", run.rows_processed === 11, run));
  }

  if (!process.env.SKIP_CLEANUP) {
    log("\n=== CLEANUP ===");
    await cleanup();
    log("Dropped scratch tables, write role (and everything it owned in the nia schema), and extra sandbox_items rows.");
  } else {
    log("\n=== SKIP_CLEANUP set: leaving scratch state in place for debugging ===");
  }

  log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  if (!process.env.SKIP_CLEANUP) {
    try {
      await cleanup();
    } catch {
      // best-effort cleanup on failure
    }
  }
  process.exit(1);
});
