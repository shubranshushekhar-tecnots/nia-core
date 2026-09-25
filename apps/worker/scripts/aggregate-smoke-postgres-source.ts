/**
 * Live smoke test for Phase 6 Block 6 — Postgres/Supabase-as-SOURCE
 * addendum: proves the aggregate pushdown compiler's `postgres` branch is a
 * real, first-class emit target, not just unit-table coverage.
 *
 * `aggregate-smoke.ts` (this directory) already proves the full runner path
 * with mysql as the source and Postgres (connector-supabase) as the
 * destination — but a destination's write path never touches
 * `compilePushdown`'s aggregate SQL emission at all (writes are plain
 * INSERT/UPSERT statements built by `writeSql.ts`, not `pushdown.ts`). The
 * "SELECT ... GROUP BY ... HAVING" text `pushdown.ts`/`queryBuilder.ts`
 * emit for postgres had only ever executed for real when postgres was the
 * DESTINATION table read back for verification — never when postgres was
 * the thing being read with a compiled GROUP BY. This script closes that
 * gap by flipping the roles: a real Postgres sandbox source table (via
 * connector-supabase), a real Aggregate transform (`COUNT(*) AS n` grouped
 * by cohort), and a real mysql (via connector-mysql) destination, driven
 * through the actual `runEtl()` runner — proving the postgres-dialect
 * `SELECT "cohort", COUNT(*) AS "n" FROM "sandbox"."<table>" GROUP BY
 * "cohort" LIMIT n` text (double-quoted identifiers, `$n` placeholders,
 * built by the exact same `quoteIdent`/`placeholder` helpers pushdown.test.ts
 * already unit-tests) round-trips through pg's `$n`-bound `client.query`
 * (services/connector-supabase/src/query.ts) against a live Postgres server.
 *
 * Run with (from apps/worker/):
 *   npx tsx scripts/aggregate-smoke-postgres-source.ts
 *
 * Prerequisites, identical to aggregate-smoke.ts's:
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
import { compilePushdown, manifestDialect, type EtlRunJob, type GraphDoc, type TransformConfig, type WorkspaceScope } from "@nia/schemas";
import { runEtl } from "../src/lib/etl/runEtl.js";
import { grantStagedMysqlWriteRole } from "./lib/stagedWriteRole.js";
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

// Dialed by the connector-supabase CONTAINER, over the compose network.
const SOURCE_CONFIG = { host: "dev-postgres", port: 5432, database: "sandbox" };
// Dialed by the connector-mysql CONTAINER, over the compose network.
const DEST_CONFIG = { host: "dev-mysql", port: 3306, database: "sandbox" };
// Dialed by THIS script, from the host, for provisioning + verification.
const HOST_PG = { host: "localhost", port: 5433, database: "sandbox", user: "postgres", password: "devroot" };
const HOST_MYSQL = { host: "localhost", port: 3307, user: "root", password: "devroot", database: "sandbox" };

const SOURCE_TABLE = "etl_aggregate_pgsrc_smoke_source";
const DEST_TABLE = "etl_aggregate_pgsrc_smoke_dest";
const WRITE_ROLE_USER = "nia_etl_aggregate_pgsrc_smoke";
const WRITE_ROLE_PASSWORD = "nia_etl_aggregate_pgsrc_smoke_pw";

// cohort -> row count; expected output is cohort -> COUNT(*).
const SEED_ROWS: { id: number; cohort: string }[] = [
  { id: 1, cohort: "eng" },
  { id: 2, cohort: "eng" },
  { id: 3, cohort: "eng" },
  { id: 4, cohort: "sales" },
  { id: 5, cohort: "sales" },
  { id: 6, cohort: "ops" },
];
const EXPECTED = { eng: 3, sales: 2, ops: 1 };

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
    await client.query(`create table ${SOURCE_TABLE} (id int primary key, cohort text not null)`);
    for (const r of SEED_ROWS) {
      await client.query(`insert into ${SOURCE_TABLE} (id, cohort) values ($1, $2)`, [r.id, r.cohort]);
    }
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
    await admin.query(`CREATE TABLE ${DEST_TABLE} (cohort VARCHAR(64) PRIMARY KEY, n INT NOT NULL)`);
    await admin.query(`DROP USER IF EXISTS '${WRITE_ROLE_USER}'@'%'`);
    await admin.query(`CREATE USER '${WRITE_ROLE_USER}'@'%' IDENTIFIED BY '${WRITE_ROLE_PASSWORD}'`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE ON sandbox.${DEST_TABLE} TO '${WRITE_ROLE_USER}'@'%'`);
    // Runner defaults to staged writes (Phase 11) — grant what the staged
    // preflight requires beyond the destination table itself.
    await grantStagedMysqlWriteRole(admin, WRITE_ROLE_USER);
  } finally {
    await admin.end();
  }
}

async function readDestRows(): Promise<Array<{ cohort: string; n: number }>> {
  const admin = await mysql.createConnection(HOST_MYSQL);
  try {
    const [rows] = await admin.query(`SELECT cohort, n FROM ${DEST_TABLE} ORDER BY cohort`);
    return rows as Array<{ cohort: string; n: number }>;
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

  const handle = `@${connectorId}-agg-pgsrc-smoke`;
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
      display_name: `Aggregate pg-source smoke (${connectorId})`,
      owner_user_id: DEMO_USER_ID,
      config,
      vault_secret_ref: vaultRef as string,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`connection insert for ${connectorId} failed: ${error?.message}`);
  return data.id as string;
}

// The Aggregate transform step this script exists to prove against a
// Postgres SOURCE: COUNT(*) grouped by cohort — nodeConfig.ts's v1
// AggregateStep shape, same fn set, different fn than aggregate-smoke.ts's
// MAX (deliberately, for coverage variety).
const AGGREGATE_TRANSFORM: TransformConfig = {
  steps: [{ kind: "aggregate", groupBy: ["cohort"], aggregations: [{ fn: "count", field: null, alias: "n" }] }],
};

async function seedWorkflowGraph(orgId: string, sourceConnId: string, destConnId: string): Promise<{ workflowId: string }> {
  const { data: existingProject } = await supabaseAdmin
    .from("projects")
    .select("id")
    .eq("org_id", orgId)
    .eq("name", "Aggregate pg-source smoke")
    .maybeSingle();
  let projectId = existingProject?.id as string | undefined;
  if (!projectId) {
    const { data, error } = await supabaseAdmin
      .from("projects")
      .insert({ org_id: orgId, name: "Aggregate pg-source smoke", created_by: DEMO_USER_ID })
      .select("id")
      .single();
    if (error || !data) throw new Error(`project insert failed: ${error?.message}`);
    projectId = data.id as string;
  }

  const { data: existingWorkflow } = await supabaseAdmin
    .from("workflows")
    .select("id")
    .eq("project_id", projectId)
    .eq("name", "Aggregate pg-source smoke")
    .maybeSingle();
  let workflowId = existingWorkflow?.id as string | undefined;
  if (!workflowId) {
    const { data, error } = await supabaseAdmin
      .from("workflows")
      .insert({ project_id: projectId, org_id: orgId, name: "Aggregate pg-source smoke", created_by: DEMO_USER_ID })
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
        manifestId: "supabase",
        connectionId: sourceConnId,
        position: { x: 0, y: 0 },
        config: { operation: "read", entity: { namespace: "public", name: SOURCE_TABLE } },
      },
      {
        id: "agg",
        type: "transform",
        position: { x: 200, y: 0 },
        config: AGGREGATE_TRANSFORM,
      },
      {
        id: "dest",
        type: "destination",
        manifestId: "mysql",
        connectionId: destConnId,
        position: { x: 400, y: 0 },
        config: {
          operation: "insert",
          entity: { namespace: "sandbox", name: DEST_TABLE },
          mapping: {
            version: 1,
            entries: [
              { from: "cohort", to: "cohort" },
              { from: "n", to: "n" },
            ],
            approvedAt: new Date().toISOString(),
          },
          upsertKeys: ["cohort"],
        },
      },
    ],
    edges: [
      { id: "e0", source: "src", target: "agg" },
      { id: "e1", source: "agg", target: "dest" },
    ],
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
  const sourceConnId = await seedConnection(orgId, "supabase", SOURCE_CONFIG);
  const destConnId = await seedConnection(orgId, "mysql", DEST_CONFIG);
  log(`Seeded connections: source=${sourceConnId} dest=${destConnId}`);

  log("\n=== COMPILED PUSHDOWN (proof the postgres dialect emits a real GROUP BY) ===");
  const dialect = manifestDialect("supabase")!;
  const plan = compilePushdown(dialect, AGGREGATE_TRANSFORM);
  log(JSON.stringify(plan, null, 2));
  track(assert("aggregate step is fully pushed down (0 residual)", plan.residualCount === 0 && plan.pushedDownCount === 1, plan));
  track(
    assert(
      "compiled dialectQuery is postgres-dialect, double-quoted, isAggregate",
      plan.dialectQuery !== null &&
        plan.dialectQuery.dialect === "postgres" &&
        plan.dialectQuery.isAggregate === true &&
        plan.dialectQuery.selectSql === '"cohort", COUNT(*) AS "n"' &&
        plan.dialectQuery.groupBySql === '"cohort"',
      plan.dialectQuery,
    ),
  );

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
    // Staged writes (Phase 11 default) also touch the "nia" staging
    // database on the mysql destination — the grant scope has to cover it
    // too, not just the destination table's own schema.
    p_scope: { schemas: ["sandbox", "nia"] },
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

  log("\n=== ASSERTIONS: runEtl() against real infra — count per cohort, Postgres source ===");

  const { data: runRow, error: runInsertError } = await supabaseAdmin
    .from("workflow_runs")
    .insert({ workflow_id: workflowId, org_id: orgId, status: "running", rows_processed: 0 })
    .select("id")
    .single();
  if (runInsertError || !runRow) throw new Error(`workflow_runs seed insert failed: ${runInsertError?.message}`);
  const runId = runRow.id as string;

  const scope: WorkspaceScope = { orgId };
  const job: EtlRunJob = {
    kind: "etl_run",
    scope,
    workflowId,
    runId,
    nodeId: "dest",
    cursor: null,
    chunkSize: 1000,
    triggeredByUserId: DEMO_USER_ID,
  };

  const captured: EtlRunJob[] = [];
  const result = await runEtl(job, queueStub(captured));
  track(assert("runEtl: status 'done' on the first call (aggregate pushdown never paginates, per Block 6)", result.status === "done", result));
  track(assert("runEtl: no next-chunk job enqueued", captured.length === 0, captured));

  const destRows = await readDestRows();
  track(assert("destination has exactly 3 rows (one per cohort)", destRows.length === 3, destRows));
  const byCohort = Object.fromEntries(destRows.map((r) => [r.cohort, r.n]));
  for (const [cohort, expectedN] of Object.entries(EXPECTED)) {
    track(assert(`cohort "${cohort}": n = ${expectedN}`, byCohort[cohort] === expectedN, byCohort));
  }

  const { data: finalRun, error: finalRunError } = await supabaseAdmin
    .from("workflow_runs")
    .select("status, rows_processed")
    .eq("id", runId)
    .single();
  if (finalRunError || !finalRun) throw new Error(`workflow_runs final read failed: ${finalRunError?.message}`);
  track(assert("workflow_runs.status: succeeded", finalRun.status === "succeeded", finalRun));
  track(assert("workflow_runs.rows_processed: 3 (one row per cohort group, not 6 source rows)", finalRun.rows_processed === 3, finalRun));

  log("\n=== RESULTING DESTINATION ROWS ===");
  log(JSON.stringify(destRows, null, 2));

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
