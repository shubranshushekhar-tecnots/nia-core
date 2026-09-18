/**
 * Live smoke test for Phase 6 Block 6's aggregate-transform vocabulary —
 * proof item (f): "highest salary per cohort" through the REAL runner path,
 * against real infrastructure (not mocks). pushdown.test.ts and
 * residualTransform.test.ts already prove the compiler/residual-executor
 * logic in isolation; this script proves the real wiring: a real mysql
 * sandbox source, a real Aggregate transform node (MAX(salary) GROUP BY
 * cohort, pushed down to the source as a real GROUP BY query — see the
 * logged compiled fragment below), and a real Postgres (via
 * connector-supabase) destination, driven through the actual runEtl()
 * runner (not a hand-rolled query), with the destination rows verified by
 * a direct query afterward.
 *
 * This also exercises runEtl.ts's Block 6 branch: an aggregate pushdown has
 * no source primary key requirement and completes as a single non-
 * paginated chunk (isLastChunk forced true) — asserted below via
 * `status === "done"` on the very first runEtl() call.
 *
 * Run with (from apps/worker/):
 *   npx tsx scripts/aggregate-smoke.ts
 * (reads apps/worker/.env for SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/
 * CONNECTOR_DEV_HOST/REDIS_URL via dotenv/config, same as env.ts.)
 *
 * Prerequisites (not started by this script), identical to
 * etl-kill-resume-smoke.ts's:
 *   - `supabase start`
 *   - `docker compose up -d --build redis dev-mysql dev-postgres
 *     connector-mysql connector-supabase`
 *   - apps/web/.env.local (or supabase status) for SUPABASE_ANON_KEY
 *
 * This script runs on the HOST: it reaches dev-mysql/dev-postgres via their
 * host-published ports (3307/5433) for direct seeding/verification, while
 * the connector-mysql/connector-supabase CONTAINERS reach the same
 * databases via compose service names through the connection rows' config —
 * same duality as every other smoke script in this directory.
 */
import { execFileSync } from "node:child_process";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import type { Queue } from "bullmq";
import { compilePushdown, manifestDialect, type EtlRunJob, type GraphDoc, type TransformConfig, type WorkspaceScope } from "@nia/schemas";
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

const MYSQL_CONTAINER = "nia-core-dev-mysql-1";
// Dialed by the connector-mysql CONTAINER, over the compose network.
const SOURCE_CONFIG = { host: "dev-mysql", port: 3306, database: "sandbox" };
// Dialed by the connector-supabase CONTAINER, over the compose network.
const DEST_CONFIG = { host: "dev-postgres", port: 5432, database: "sandbox" };
// Dialed by THIS script, from the host, for provisioning + verification.
const HOST_PG = { host: "localhost", port: 5433, database: "sandbox", user: "postgres", password: "devroot" };

const SOURCE_TABLE = "etl_aggregate_smoke_source";
const DEST_TABLE = "etl_aggregate_smoke_dest";
const WRITE_ROLE_USER = "nia_etl_aggregate_smoke";
const WRITE_ROLE_PASSWORD = "nia_etl_aggregate_smoke_pw";

// cohort -> [salaries]; expected output is cohort -> MAX(salaries).
const SEED_ROWS: { id: number; cohort: string; salary: number }[] = [
  { id: 1, cohort: "eng", salary: 100000 },
  { id: 2, cohort: "eng", salary: 200000 },
  { id: 3, cohort: "eng", salary: 150000 },
  { id: 4, cohort: "sales", salary: 80000 },
  { id: 5, cohort: "sales", salary: 120000 },
  { id: 6, cohort: "ops", salary: 90000 },
];
const EXPECTED = { eng: 200000, sales: 120000, ops: 90000 };

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

function provisionMysqlSourceTable(): void {
  mysqlExec(`DROP TABLE IF EXISTS ${SOURCE_TABLE};`);
  mysqlExec(`CREATE TABLE ${SOURCE_TABLE} (id INT PRIMARY KEY, cohort VARCHAR(64) NOT NULL, salary INT NOT NULL);`);
  const values = SEED_ROWS.map((r) => `(${r.id}, '${r.cohort}', ${r.salary})`).join(", ");
  mysqlExec(`INSERT INTO ${SOURCE_TABLE} (id, cohort, salary) VALUES ${values};`);
}

function cleanupMysqlSourceTable(): void {
  mysqlExec(`DROP TABLE IF EXISTS ${SOURCE_TABLE};`);
}

async function provisionScratchDestTableAndRole(): Promise<void> {
  const client = new pg.Client(HOST_PG);
  await client.connect();
  try {
    await client.query(`drop table if exists ${DEST_TABLE}`);
    await client.query(`create table ${DEST_TABLE} (cohort text primary key, max_salary int not null)`);
    const { rowCount } = await client.query("select 1 from pg_roles where rolname = $1", [WRITE_ROLE_USER]);
    if (!rowCount) {
      await client.query(`create role ${WRITE_ROLE_USER} with login password '${WRITE_ROLE_PASSWORD}'`);
    }
    await client.query(`grant connect on database sandbox to ${WRITE_ROLE_USER}`);
    await client.query(`grant usage on schema public to ${WRITE_ROLE_USER}`);
    await client.query(`grant select, insert, update on ${DEST_TABLE} to ${WRITE_ROLE_USER}`);
  } finally {
    await client.end();
  }
}

async function readDestRows(): Promise<Array<{ cohort: string; max_salary: number }>> {
  const client = new pg.Client(HOST_PG);
  await client.connect();
  try {
    const { rows } = await client.query(`select cohort, max_salary from ${DEST_TABLE} order by cohort`);
    return rows as Array<{ cohort: string; max_salary: number }>;
  } finally {
    await client.end();
  }
}

async function cleanupScratchDestTableAndRole(): Promise<void> {
  const client = new pg.Client(HOST_PG);
  await client.connect();
  try {
    await client.query(`drop table if exists ${DEST_TABLE}`);
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

  const handle = `@${connectorId}-agg-smoke`;
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
      display_name: `Aggregate smoke (${connectorId})`,
      owner_user_id: DEMO_USER_ID,
      config,
      vault_secret_ref: vaultRef as string,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`connection insert for ${connectorId} failed: ${error?.message}`);
  return data.id as string;
}

// The Aggregate transform step this whole smoke test exists to prove:
// MAX(salary) grouped by cohort — nodeConfig.ts's v1 AggregateStep shape.
const AGGREGATE_TRANSFORM: TransformConfig = {
  steps: [{ kind: "aggregate", groupBy: ["cohort"], aggregations: [{ fn: "max", field: "salary", alias: "max_salary" }] }],
};

async function seedWorkflowGraph(orgId: string, sourceConnId: string, destConnId: string): Promise<{ workflowId: string }> {
  const { data: existingProject } = await supabaseAdmin
    .from("projects")
    .select("id")
    .eq("org_id", orgId)
    .eq("name", "Aggregate smoke")
    .maybeSingle();
  let projectId = existingProject?.id as string | undefined;
  if (!projectId) {
    const { data, error } = await supabaseAdmin
      .from("projects")
      .insert({ org_id: orgId, name: "Aggregate smoke", created_by: DEMO_USER_ID })
      .select("id")
      .single();
    if (error || !data) throw new Error(`project insert failed: ${error?.message}`);
    projectId = data.id as string;
  }

  const { data: existingWorkflow } = await supabaseAdmin
    .from("workflows")
    .select("id")
    .eq("project_id", projectId)
    .eq("name", "Aggregate smoke")
    .maybeSingle();
  let workflowId = existingWorkflow?.id as string | undefined;
  if (!workflowId) {
    const { data, error } = await supabaseAdmin
      .from("workflows")
      .insert({ project_id: projectId, org_id: orgId, name: "Aggregate smoke", created_by: DEMO_USER_ID })
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
        config: { operation: "read", entity: { namespace: "sandbox", name: SOURCE_TABLE } },
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
        manifestId: "supabase",
        connectionId: destConnId,
        position: { x: 400, y: 0 },
        config: {
          operation: "insert",
          entity: { namespace: "public", name: DEST_TABLE },
          mapping: {
            version: 1,
            entries: [
              { from: "cohort", to: "cohort" },
              { from: "max_salary", to: "max_salary" },
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
  provisionMysqlSourceTable();
  await provisionScratchDestTableAndRole();
  const orgId = await getOrgId();
  const sourceConnId = await seedConnection(orgId, "mysql", SOURCE_CONFIG);
  const destConnId = await seedConnection(orgId, "supabase", DEST_CONFIG);
  log(`Seeded connections: source=${sourceConnId} dest=${destConnId}`);

  log("\n=== COMPILED PUSHDOWN (proof it's a real GROUP BY, not client-side aggregation) ===");
  const dialect = manifestDialect("mysql")!;
  const plan = compilePushdown(dialect, AGGREGATE_TRANSFORM);
  log(JSON.stringify(plan, null, 2));
  track(assert("aggregate step is fully pushed down (0 residual)", plan.residualCount === 0 && plan.pushedDownCount === 1, plan));
  track(assert("compiled dialectQuery.isAggregate is true", plan.dialectQuery !== null && plan.dialectQuery.isAggregate === true, plan.dialectQuery));

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

  log("\n=== ASSERTIONS: runEtl() against real infra — highest salary per cohort ===");

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
  const byCohort = Object.fromEntries(destRows.map((r) => [r.cohort, r.max_salary]));
  for (const [cohort, expectedMax] of Object.entries(EXPECTED)) {
    track(assert(`cohort "${cohort}": max_salary = ${expectedMax}`, byCohort[cohort] === expectedMax, byCohort));
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
  cleanupMysqlSourceTable();
  await cleanupScratchDestTableAndRole();
  log("Dropped mysql source scratch table + postgres dest scratch table/write role.");

  log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  try {
    cleanupMysqlSourceTable();
  } catch {
    // best-effort cleanup on failure
  }
  try {
    await cleanupScratchDestTableAndRole();
  } catch {
    // best-effort cleanup on failure
  }
  process.exit(1);
});
