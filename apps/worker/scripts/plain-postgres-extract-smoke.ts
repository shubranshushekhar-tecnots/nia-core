/**
 * Live smoke test closing the coverage gap flagged in the Phase 10 exit
 * report's "Open risks": no existing script had ever driven a PLAIN
 * (non-aggregate) postgres/supabase SOURCE extraction through the real
 * runEtl() chunked keyset-pagination path. Every other postgres-source
 * script either exercises aggregate pushdown
 * (aggregate-smoke-postgres-source.ts, which skips the primaryKey
 * precondition entirely — see runEtl.ts's isAggregatePushdown exemption)
 * or uses postgres only as a DESTINATION (etl-kill-resume-smoke.ts,
 * write-smoke.ts), whose write path keys off destConfig.upsertKeys, not
 * entity.primaryKey. That's precisely why the Phase 10 postgres
 * primary-key-detection bug (connector-supabase's /introspect always
 * returning primaryKey: null to the SELECT-only nia_ro role — fixed via
 * pg_catalog instead of information_schema.table_constraints/
 * key_column_usage) went unnoticed since Phase 6 Block 3.5: nothing ever
 * called runEtl() with a plain postgres SQL source entity and asserted on
 * the result.
 *
 * This script does exactly that: a real Postgres sandbox source table
 * (2,500 rows, single-column int primary key, read via connector-supabase
 * as nia_ro — the same read-only role every real connection uses), no
 * transform node (direct source -> destination edge), a real mysql
 * (connector-mysql) destination, driven through the real runEtl() chunk
 * loop with chunkSize 1000 so the run spans exactly 3 chunks
 * (1000 + 1000 + 500, per queryBuilder.ts's MAX_CHUNK_ROWS cap). Asserts
 * the destination ends up with exactly 2,500 rows and zero duplicate keys
 * — i.e. keyset pagination neither skips nor double-writes rows across
 * chunk boundaries now that entity.primaryKey is populated correctly.
 *
 * Run with (from apps/worker/):
 *   npx tsx scripts/plain-postgres-extract-smoke.ts
 *
 * Prerequisites, identical to aggregate-smoke-postgres-source.ts's:
 *   - `supabase start`
 *   - `docker compose up -d --build redis dev-mysql dev-postgres
 *     connector-mysql connector-supabase`
 *   - apps/web/.env.local (or supabase status) for SUPABASE_ANON_KEY
 *
 * Host/container duality: this script reaches dev-postgres/dev-mysql via
 * their host-published ports (5433/3307) for direct seeding/verification;
 * the connector-supabase/connector-mysql CONTAINERS reach the same
 * databases via compose service names through the connection rows' config.
 */
import mysql from "mysql2/promise";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import type { Queue } from "bullmq";
import type { EtlRunJob, GraphDoc, WorkspaceScope } from "@nia/schemas";
import { runEtl } from "../src/lib/etl/runEtl.js";

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

// Dialed by the connector-supabase CONTAINER, over the compose network.
const SOURCE_CONFIG = { host: "dev-postgres", port: 5432, database: "sandbox" };
// Dialed by the connector-mysql CONTAINER, over the compose network.
const DEST_CONFIG = { host: "dev-mysql", port: 3306, database: "sandbox" };
// Dialed by THIS script, from the host, for provisioning + verification.
const HOST_PG = { host: "localhost", port: 5433, database: "sandbox", user: "postgres", password: "devroot" };
const HOST_MYSQL = { host: "localhost", port: 3307, user: "root", password: "devroot", database: "sandbox" };

const SOURCE_TABLE = "etl_plain_pgsrc_smoke_source";
const DEST_TABLE = "etl_plain_pgsrc_smoke_dest";
const WRITE_ROLE_USER = "nia_etl_plain_pgsrc_smoke";
const WRITE_ROLE_PASSWORD = "nia_etl_plain_pgsrc_smoke_pw";

const ROW_COUNT = 2500;
const CHUNK_SIZE = 1000;
const EXPECTED_CHUNKS = 3; // 1000 + 1000 + 500

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

async function provisionPgSourceTable(): Promise<void> {
  const client = new pg.Client(HOST_PG);
  await client.connect();
  try {
    await client.query(`drop table if exists ${SOURCE_TABLE}`);
    await client.query(`create table ${SOURCE_TABLE} (id int primary key, name text not null)`);
    await client.query(
      `insert into ${SOURCE_TABLE} (id, name) select g, 'row-' || g from generate_series(1, $1) as g`,
      [ROW_COUNT],
    );
  } finally {
    await client.end();
  }
}

async function cleanupPgSourceTable(): Promise<void> {
  const client = new pg.Client(HOST_PG);
  await client.connect();
  try {
    await client.query(`drop table if exists ${SOURCE_TABLE}`);
  } finally {
    await client.end();
  }
}

async function provisionMysqlDestTableAndRole(): Promise<void> {
  const admin = await mysql.createConnection(HOST_MYSQL);
  try {
    await admin.query(`DROP TABLE IF EXISTS ${DEST_TABLE}`);
    await admin.query(`CREATE TABLE ${DEST_TABLE} (id INT PRIMARY KEY, name VARCHAR(64) NOT NULL)`);
    await admin.query(`DROP USER IF EXISTS '${WRITE_ROLE_USER}'@'%'`);
    await admin.query(`CREATE USER '${WRITE_ROLE_USER}'@'%' IDENTIFIED BY '${WRITE_ROLE_PASSWORD}'`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE ON sandbox.${DEST_TABLE} TO '${WRITE_ROLE_USER}'@'%'`);
  } finally {
    await admin.end();
  }
}

async function readDestRows(): Promise<Array<{ id: number; name: string }>> {
  const admin = await mysql.createConnection(HOST_MYSQL);
  try {
    const [rows] = await admin.query(`SELECT id, name FROM ${DEST_TABLE} ORDER BY id`);
    return rows as Array<{ id: number; name: string }>;
  } finally {
    await admin.end();
  }
}

async function cleanupMysqlDestTableAndRole(): Promise<void> {
  const admin = await mysql.createConnection(HOST_MYSQL);
  try {
    await admin.query(`DROP TABLE IF EXISTS ${DEST_TABLE}`);
    await admin.query(`DROP USER IF EXISTS '${WRITE_ROLE_USER}'@'%'`);
  } finally {
    await admin.end();
  }
}

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
  secret: { user: string; password: string },
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
    p_secret: secret,
  });
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

async function seedWorkflowGraph(orgId: string, sourceConnId: string, destConnId: string): Promise<{ workflowId: string }> {
  const { data: existingProject } = await supabaseAdmin
    .from("projects")
    .select("id")
    .eq("org_id", orgId)
    .eq("name", "Plain postgres-source extract smoke")
    .maybeSingle();
  let projectId = existingProject?.id as string | undefined;
  if (!projectId) {
    const { data, error } = await supabaseAdmin
      .from("projects")
      .insert({ org_id: orgId, name: "Plain postgres-source extract smoke", created_by: DEMO_USER_ID })
      .select("id")
      .single();
    if (error || !data) throw new Error(`project insert failed: ${error?.message}`);
    projectId = data.id as string;
  }

  const { data: existingWorkflow } = await supabaseAdmin
    .from("workflows")
    .select("id")
    .eq("project_id", projectId)
    .eq("name", "Plain postgres-source extract smoke")
    .maybeSingle();
  let workflowId = existingWorkflow?.id as string | undefined;
  if (!workflowId) {
    const { data, error } = await supabaseAdmin
      .from("workflows")
      .insert({ project_id: projectId, org_id: orgId, name: "Plain postgres-source extract smoke", created_by: DEMO_USER_ID })
      .select("id")
      .single();
    if (error || !data) throw new Error(`workflow insert failed: ${error?.message}`);
    workflowId = data.id as string;
  }

  // No transform node — direct source -> destination edge, same shape as
  // etl-kill-resume-smoke.ts's graph. This is deliberately the PLAIN
  // extraction path (entity.primaryKey-gated keyset pagination), not the
  // aggregate-pushdown path aggregate-smoke-postgres-source.ts covers.
  const graph: GraphDoc = {
    nodes: [
      {
        id: "src",
        type: "source",
        manifestId: "supabase",
        connectionId: sourceConnId,
        position: { x: 0, y: 0 },
        config: { operation: "read", entity: { namespace: "public", name: SOURCE_TABLE } },
      },
      {
        id: "dest",
        type: "destination",
        manifestId: "mysql",
        connectionId: destConnId,
        position: { x: 200, y: 0 },
        config: {
          operation: "insert",
          entity: { namespace: "sandbox", name: DEST_TABLE },
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

  log("=== SEEDING ===");
  await provisionPgSourceTable();
  await provisionMysqlDestTableAndRole();
  const orgId = await getOrgId();
  // Source connects as nia_ro — the same read-only role every real
  // connection (and every other smoke/agreement/kill-test script) uses.
  // This is the crux of what this script proves: THIS role, through THIS
  // path, now gets a correct entity.primaryKey from connector-supabase's
  // pg_catalog-based /introspect fix.
  const sourceConnId = await seedConnection(
    orgId,
    "supabase",
    "@supabase-plain-pgsrc-smoke",
    "Plain pg-source extract smoke (supabase)",
    SOURCE_CONFIG,
    { user: "nia_ro", password: "nia_ro_pw" },
  );
  const destConnId = await seedConnection(
    orgId,
    "mysql",
    "@mysql-plain-pgsrc-smoke",
    "Plain pg-source extract smoke (mysql)",
    DEST_CONFIG,
    { user: "nia_ro", password: "nia_ro_pw" },
  );
  log(`Seeded connections: source=${sourceConnId} dest=${destConnId}`);

  const writeVaultRef = await (async () => {
    const { data, error } = await supabaseAdmin.rpc("create_connector_secret", {
      p_secret: { user: WRITE_ROLE_USER, password: WRITE_ROLE_PASSWORD },
    });
    if (error || !data) throw new Error(`vault write for write cred failed: ${error?.message}`);
    return data as string;
  })();

  const supabaseUser = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signInError } = await supabaseUser.auth.signInWithPassword({ email: DEMO_EMAIL, password: DEMO_PASSWORD });
  if (signInError) throw new Error(`sign-in as demo user failed: ${signInError.message}`);

  const { data: grantRow, error: grantError } = await supabaseUser.rpc("create_write_grant", {
    p_connection_id: destConnId,
    p_scope: { schemas: ["sandbox"] },
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

  log("\n=== ASSERTIONS: runEtl() plain postgres-source extraction against real infra ===");

  const { data: runRow, error: runInsertError } = await supabaseAdmin
    .from("workflow_runs")
    .insert({ workflow_id: workflowId, org_id: orgId, status: "running", rows_processed: 0 })
    .select("id")
    .single();
  if (runInsertError || !runRow) throw new Error(`workflow_runs seed insert failed: ${runInsertError?.message}`);
  const runId = runRow.id as string;

  const scope: WorkspaceScope = { orgId };
  let job: EtlRunJob = {
    kind: "etl_run",
    scope,
    workflowId,
    runId,
    nodeId: "dest",
    cursor: null,
    chunkSize: CHUNK_SIZE,
    triggeredByUserId: DEMO_USER_ID,
  };

  let chunks = 0;
  let result: Awaited<ReturnType<typeof runEtl>> | undefined;
  const cursorsSeen: Array<string | number | null | undefined> = [];
  do {
    const captured: EtlRunJob[] = [];
    result = await runEtl(job, queueStub(captured));
    chunks++;
    log(`  chunk ${chunks}: status=${result.status} nextCursor=${JSON.stringify(result.nextCursor)}`);
    cursorsSeen.push(result.nextCursor);
    if (result.status === "chunk") {
      const next = captured[captured.length - 1];
      if (!next) throw new Error("expected a next-chunk job to be enqueued for a 'chunk' result");
      job = next;
    }
  } while (result.status === "chunk");

  track(assert("runEtl: final status 'done'", result.status === "done", result));
  track(
    assert(
      `runEtl: spanned exactly ${EXPECTED_CHUNKS} chunks (1000 + 1000 + 500, per MAX_CHUNK_ROWS=${CHUNK_SIZE})`,
      chunks === EXPECTED_CHUNKS,
      { chunks, cursorsSeen },
    ),
  );

  const destRows = await readDestRows();
  track(assert(`destination has exactly ${ROW_COUNT} rows`, destRows.length === ROW_COUNT, { count: destRows.length }));
  const uniqueIds = new Set(destRows.map((r) => r.id));
  track(assert("0 duplicate rows by key (id)", uniqueIds.size === destRows.length, { rows: destRows.length, uniqueIds: uniqueIds.size }));
  const expectedIds = Array.from({ length: ROW_COUNT }, (_, i) => i + 1);
  track(
    assert(
      "destination ids match the source's 1..2500 exactly (no skips, no phantom rows)",
      JSON.stringify(destRows.map((r) => r.id)) === JSON.stringify(expectedIds),
      { first: destRows[0], last: destRows[destRows.length - 1] },
    ),
  );

  const { data: finalRun, error: finalRunError } = await supabaseAdmin
    .from("workflow_runs")
    .select("status, rows_processed")
    .eq("id", runId)
    .single();
  if (finalRunError || !finalRun) throw new Error(`workflow_runs final read failed: ${finalRunError?.message}`);
  track(assert("workflow_runs.status: succeeded", finalRun.status === "succeeded", finalRun));
  track(assert(`workflow_runs.rows_processed: ${ROW_COUNT}`, finalRun.rows_processed === ROW_COUNT, finalRun));

  log("\n=== CLEANUP ===");
  await cleanupPgSourceTable();
  await cleanupMysqlDestTableAndRole();
  log("Dropped postgres source scratch table + mysql dest scratch table/write role.");

  log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await cleanupPgSourceTable();
  } catch {
    // best-effort cleanup on failure
  }
  try {
    await cleanupMysqlDestTableAndRole();
  } catch {
    // best-effort cleanup on failure
  }
  process.exit(1);
});
