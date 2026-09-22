/**
 * Live smoke test for the core "messy mysql -> clean -> staged postgres"
 * scenario, proving Schema-layer Part 5 follow-up's destination-contract
 * fix (buildRuntimeContract/compileTransformOutputSchema,
 * apps/worker/src/lib/etl/ensureDestination.ts) against a REAL mysql
 * source and a REAL brand-new Postgres destination table (ensureDestination's
 * CREATE path) — not mocks. destination-contract-smoke.ts already proves
 * this fix against a mongo source with nested/array fields; this script
 * proves the scenario the fix was actually written for: a messy mysql
 * table, a to_number cleaning step on one column, an untouched text column
 * with meaningful leading zeros, and an aggregate rollup — each landing in
 * its own brand-new destination table with the CORRECT native column
 * types (derived from the pipeline's post-transform output schema, not the
 * raw source schema).
 *
 * Two scenarios, run against two separate brand-new destination tables:
 *   1. "clean" — computed_field to_number(amount) [onFailure: quarantine],
 *      zip left completely unmapped-through (no transform step touches
 *      it). Asserts: the auto-created `amount` column is double precision
 *      (to_number's declared return type, niaExprType.ts), the
 *      auto-created `zip` column is text, and a zip value with a leading
 *      zero ("00501") round-trips byte-for-byte — proving no numeric
 *      coercion happened to a column nothing declared as numeric. Also
 *      asserts the one row whose amount can't be parsed is quarantined,
 *      never reaches the destination.
 *   2. "aggregate" — the same to_number cleaning step, chained into an
 *      Aggregate transform (group by category; sum(amount) as
 *      total_amount, count as row_count) landing in a SECOND brand-new
 *      destination table. Asserts: total_amount is double precision (sum's
 *      declared return type, packages/schemas/src/ops/aggregate.ts) and
 *      row_count is bigint (count's declared integer type ->
 *      niaAdapters.ts's postgresFromNiaType), with the aggregated values
 *      themselves correct (the quarantined row correctly excluded from
 *      both the sum and the count).
 *
 * Run with (from apps/worker/):
 *   npx tsx scripts/clean-mysql-postgres-contract-smoke.ts
 *
 * Prerequisites (not started by this script):
 *   - `supabase start`
 *   - `redis`/`dev-mysql`/`dev-postgres`/`connector-mysql`/
 *     `connector-supabase` rebuilt+started (always a fresh connector
 *     image — see docs/decisions.md's Phase 11 "stale image" lesson).
 *   - apps/web/.env.local (or supabase status) for SUPABASE_ANON_KEY.
 *
 * Host/container duality: this script runs on the HOST, reaching
 * dev-mysql/dev-postgres via their host-published ports (3307/5433) for
 * seeding/verification, while the connector-mysql/connector-supabase
 * CONTAINERS reach the same databases via compose service names
 * (dev-mysql:3306, dev-postgres:5432) through the connections' `config`.
 */
import { execFileSync } from "node:child_process";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import type { Queue } from "bullmq";
import type { EtlRunJob, GraphDoc, TransformConfig } from "@nia/schemas";
import { runEtl } from "../src/lib/etl/runEtl.js";
import type { WorkspaceScope } from "../src/lib/workspaceScope.js";
import { grantStagedPostgresWriteRole } from "./lib/stagedWriteRole.js";

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

const SOURCE_TABLE = "contract_clean_smoke_src";
const DEST_TABLE_CLEAN = "contract_clean_smoke_dest";
const DEST_TABLE_AGG = "contract_clean_smoke_dest_agg";
const WRITE_ROLE_USER = "nia_contract_clean_smoke";
const WRITE_ROLE_PASSWORD = "nia_contract_clean_smoke_pw";

// id=3's amount is unparseable -> quarantined by the explicit to_number
// computed_field step in BOTH scenarios, never reaching either
// destination or feeding the aggregate. zip values on id=1/id=2 carry
// meaningful leading zeros that must survive untouched (never mapped
// through any transform step, and never coerced by the destination
// contract into anything other than text).
const SEED_ROWS: { id: number; category: string; amount: string; zip: string }[] = [
  { id: 1, category: "A", amount: "12.50", zip: "02134" },
  { id: 2, category: "A", amount: "7", zip: "00501" },
  { id: 3, category: "B", amount: "not-a-number", zip: "33101" },
  { id: 4, category: "B", amount: "3.25", zip: "10001" },
];

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

function assert(label: string, cond: boolean, detail?: unknown): boolean {
  log(`  ${cond ? "PASS" : "FAIL"}  ${label} ${!cond && detail !== undefined ? JSON.stringify(detail) : ""}`);
  return cond;
}

function mysqlExec(sql: string): void {
  execFileSync("docker", ["exec", MYSQL_CONTAINER, "mysql", "-uroot", "-pdevroot", "sandbox", "-e", sql]);
}

function provisionMysqlSourceTable(): void {
  mysqlExec(`DROP TABLE IF EXISTS ${SOURCE_TABLE};`);
  mysqlExec(
    `CREATE TABLE ${SOURCE_TABLE} (id INT PRIMARY KEY, category VARCHAR(16) NOT NULL, amount VARCHAR(32) NOT NULL, zip VARCHAR(16) NOT NULL);`,
  );
  const values = SEED_ROWS.map((r) => `(${r.id}, '${r.category}', '${r.amount}', '${r.zip}')`).join(", ");
  mysqlExec(`INSERT INTO ${SOURCE_TABLE} (id, category, amount, zip) VALUES ${values};`);
}

function cleanupMysqlSourceTable(): void {
  mysqlExec(`DROP TABLE IF EXISTS ${SOURCE_TABLE};`);
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

async function provisionRoleAndTables(): Promise<void> {
  await withHostPg(async (client) => {
    for (const table of [DEST_TABLE_CLEAN, DEST_TABLE_AGG]) {
      await client.query(`drop table if exists ${table}`);
    }
    const { rowCount } = await client.query("select 1 from pg_roles where rolname = $1", [WRITE_ROLE_USER]);
    if (!rowCount) {
      await client.query(`create role ${WRITE_ROLE_USER} with login password '${WRITE_ROLE_PASSWORD}'`);
    }
    await client.query(`grant connect on database sandbox to ${WRITE_ROLE_USER}`);
    // Neither destination table pre-exists — the write role itself CREATEs
    // both (ensureDestination's CREATE path), same as
    // destination-contract-smoke.ts's single-table case.
    await client.query(`grant create, usage on schema public to ${WRITE_ROLE_USER}`);
    await grantStagedPostgresWriteRole(client, "sandbox", WRITE_ROLE_USER);
  });
}

async function cleanup(): Promise<void> {
  await withHostPg(async (client) => {
    for (const table of [DEST_TABLE_CLEAN, DEST_TABLE_AGG]) {
      await client.query(`drop table if exists ${table}`);
    }
    const { rowCount } = await client.query("select 1 from pg_roles where rolname = $1", [WRITE_ROLE_USER]);
    if (rowCount) {
      await client.query(`revoke create on schema public from ${WRITE_ROLE_USER}`).catch(() => {});
      await client.query(`drop owned by ${WRITE_ROLE_USER}`);
      await client.query(`drop role if exists ${WRITE_ROLE_USER}`);
    }
  });
  cleanupMysqlSourceTable();
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

  const handle = `@${connectorId}-contract-clean-smoke`;
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
      display_name: `Contract clean smoke (${connectorId})`,
      owner_user_id: DEMO_USER_ID,
      config,
      vault_secret_ref: vaultRef as string,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`connection insert for ${connectorId} failed: ${error?.message}`);
  return data.id as string;
}

// The one fallible cleaning step both scenarios share: to_number(amount),
// overwriting `amount` in place. `zip` is deliberately never referenced by
// any transform step in either scenario — it must reach the destination
// contract as-is, typed from its own (text) source column.
const CLEAN_STEP = {
  kind: "computed_field" as const,
  // `name` is the field being SET, not a label — "amount" here overwrites
  // the raw source column in place (same in-place-overwrite pattern as
  // destination-contract-smoke.ts's "qty" step), so the mapping's
  // `amount -> amount` entry (and the aggregate's `sum(field: "amount")`
  // in scenario 2) both resolve against the CLEANED value, not the raw
  // text column.
  name: "amount",
  expression: { kind: "call" as const, fn: "to_number", args: [{ kind: "field" as const, name: "amount" }] },
  onFailure: "quarantine" as const,
};

const CLEAN_TRANSFORM: TransformConfig = { steps: [CLEAN_STEP] };
const AGG_TRANSFORM: TransformConfig = {
  steps: [
    CLEAN_STEP,
    {
      kind: "aggregate",
      groupBy: ["category"],
      aggregations: [
        { fn: "sum", field: "amount", alias: "total_amount" },
        { fn: "count", field: null, alias: "row_count" },
      ],
    },
  ],
};

async function seedProjectAndWorkflow(orgId: string, workflowName: string): Promise<{ workflowId: string }> {
  const { data: existingProject } = await supabaseAdmin
    .from("projects")
    .select("id")
    .eq("org_id", orgId)
    .eq("name", "Contract clean smoke")
    .maybeSingle();
  let projectId = existingProject?.id as string | undefined;
  if (!projectId) {
    const { data, error } = await supabaseAdmin
      .from("projects")
      .insert({ org_id: orgId, name: "Contract clean smoke", created_by: DEMO_USER_ID })
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
  return { workflowId };
}

async function seedGraph(
  workflowId: string,
  sourceConnId: string,
  destConnId: string,
  transform: TransformConfig,
  destTable: string,
  mappingEntries: { from: string; to: string }[],
  upsertKeys: string[],
): Promise<void> {
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
        id: "tf",
        type: "transform",
        position: { x: 200, y: 0 },
        config: transform,
      },
      {
        id: "dest",
        type: "destination",
        manifestId: "supabase",
        connectionId: destConnId,
        position: { x: 400, y: 0 },
        config: {
          operation: "insert",
          entity: { namespace: "public", name: destTable },
          mapping: { version: 1, entries: mappingEntries, approvedAt: new Date().toISOString() },
          upsertKeys,
          // writeMode deliberately absent -> defaults to "staged", the
          // only mode ensureDestination's CREATE path is wired into.
        },
      },
    ],
    edges: [
      { id: "e0", source: "src", target: "tf" },
      { id: "e1", source: "tf", target: "dest" },
    ],
  };

  const { error } = await supabaseAdmin.from("workflow_graphs").upsert({ workflow_id: workflowId, graph }, { onConflict: "workflow_id" });
  if (error) throw new Error(`workflow_graphs upsert failed: ${error.message}`);
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

async function main(): Promise<void> {
  let failures = 0;
  const track = (ok: boolean) => {
    if (!ok) failures++;
  };

  log("=== SEEDING (not part of the destination-contract proof below) ===");
  provisionMysqlSourceTable();
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
  // Scenario 1: clean -> brand-new postgres table
  // =====================================================================
  log("\n=== SCENARIO 1: messy mysql -> to_number(amount), zip untouched -> brand-new postgres table ===");
  {
    const { workflowId } = await seedProjectAndWorkflow(orgId, "Contract clean smoke - clean");
    await seedGraph(
      workflowId,
      sourceConnId,
      destConnId,
      CLEAN_TRANSFORM,
      DEST_TABLE_CLEAN,
      [
        { from: "id", to: "id" },
        { from: "category", to: "category" },
        { from: "amount", to: "amount" },
        { from: "zip", to: "zip" },
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
      chunkSize: 10, // only 4 source rows -> single chunk
      triggeredByUserId: DEMO_USER_ID,
    };

    const result = await runEtl(job, queueStub([]));
    track(assert("status 'done'", result.status === "done", result));

    const run = await getRunStatus(runId);
    track(assert("workflow_runs.status: succeeded", run.status === "succeeded", run));
    track(assert("workflow_runs.rows_processed: 3 (id=3's amount unparseable -> quarantined)", run.rows_processed === 3, run));

    await withHostPg(async (client) => {
      const { rows: cols } = await client.query(
        "select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = $1 order by column_name",
        [DEST_TABLE_CLEAN],
      );
      const byName = new Map(cols.map((c) => [c.column_name as string, c.data_type as string]));
      track(assert("created table exists with exactly the 4 mapped columns", cols.length === 4, cols));
      track(assert("amount column: created as numeric (double precision, to_number's declared return type)", byName.get("amount") === "double precision", byName.get("amount")));
      track(assert("zip column: created as text (never referenced by any transform step)", byName.get("zip") === "text", byName.get("zip")));

      // id casts to int in the query: the created `id` column is BIGINT
      // (mysql INT -> NiaType "integer" -> niaAdapters.ts's
      // postgresFromNiaType), which node-postgres returns as a STRING by
      // default (int8 has no lossless JS number representation) — cast it
      // back down here purely for this script's own JS-side comparisons.
      const { rows: destRows } = await client.query(`select id::int as id, category, amount, zip from ${DEST_TABLE_CLEAN} order by id`);
      track(assert("3 rows written (id=3 quarantined, never reaches the destination)", destRows.length === 3, destRows));
      track(assert("quarantined row (id=3) is absent from the destination", !destRows.some((r) => r.id === 3), destRows));

      const row1 = destRows.find((r) => r.id === 1);
      const row2 = destRows.find((r) => r.id === 2);
      track(assert('row id=1: zip "02134" kept byte-for-byte (leading zero preserved, text column)', row1?.zip === "02134", row1));
      track(assert('row id=2: zip "00501" kept byte-for-byte (leading zero preserved, text column)', row2?.zip === "00501", row2));
      track(assert("row id=1: amount cleaned to the number 12.5", row1?.amount === 12.5, row1));
      track(assert("row id=2: amount cleaned to the number 7", row2?.amount === 7, row2));

      const { rows: quarantined } = await client.query(
        "select function, status from nia.nia_quarantine where run_id = $1 and (source_row->>'id')::int = 3",
        [runId],
      );
      track(assert("id=3 recorded in the quarantine sink, function to_number", quarantined.length === 1 && quarantined[0].function === "to_number", quarantined));
    });
  }

  // =====================================================================
  // Scenario 2: clean + aggregate -> a second brand-new postgres table
  // =====================================================================
  log("\n=== SCENARIO 2: same cleaning step, chained into an aggregate -> a second brand-new postgres table ===");
  {
    const { workflowId } = await seedProjectAndWorkflow(orgId, "Contract clean smoke - aggregate");
    await seedGraph(
      workflowId,
      sourceConnId,
      destConnId,
      AGG_TRANSFORM,
      DEST_TABLE_AGG,
      [
        { from: "category", to: "category" },
        { from: "total_amount", to: "total_amount" },
        { from: "row_count", to: "row_count" },
      ],
      ["category"],
    );
    const runId = await createRun(workflowId, orgId);
    const job: EtlRunJob = {
      kind: "etl_run",
      scope,
      workflowId,
      runId,
      nodeId: "dest",
      cursor: null,
      chunkSize: 10,
      triggeredByUserId: DEMO_USER_ID,
    };

    const result = await runEtl(job, queueStub([]));
    track(assert("status 'done'", result.status === "done", result));

    const run = await getRunStatus(runId);
    track(assert("workflow_runs.status: succeeded", run.status === "succeeded", run));
    track(assert("workflow_runs.rows_processed: 2 (one row per category group)", run.rows_processed === 2, run));

    await withHostPg(async (client) => {
      const { rows: cols } = await client.query(
        "select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = $1 order by column_name",
        [DEST_TABLE_AGG],
      );
      const byName = new Map(cols.map((c) => [c.column_name as string, c.data_type as string]));
      track(assert("created table exists with exactly the 3 mapped columns", cols.length === 3, cols));
      track(assert("total_amount column: created as numeric (double precision, sum's declared return type)", byName.get("total_amount") === "double precision", byName.get("total_amount")));
      track(assert("row_count column: created as bigint (count's declared integer type)", byName.get("row_count") === "bigint", byName.get("row_count")));

      const { rows: destRows } = await client.query(`select category, total_amount, row_count from ${DEST_TABLE_AGG} order by category`);
      track(assert("2 rows written (one per category)", destRows.length === 2, destRows));

      const byCategory = Object.fromEntries(destRows.map((r) => [r.category, r]));
      // category A: 12.50 + 7 = 19.5, 2 rows, no quarantine in this group.
      track(assert('category "A": total_amount = 19.5', byCategory.A?.total_amount === 19.5, byCategory.A));
      track(assert('category "A": row_count = 2', Number(byCategory.A?.row_count) === 2, byCategory.A));
      // category B: id=3 quarantined before the aggregate ever sees it ->
      // only id=4 (3.25) contributes.
      track(assert('category "B": total_amount = 3.25 (id=3 excluded, quarantined upstream)', byCategory.B?.total_amount === 3.25, byCategory.B));
      track(assert('category "B": row_count = 1 (id=3 excluded, quarantined upstream)', Number(byCategory.B?.row_count) === 1, byCategory.B));
    });
  }

  if (!process.env.SKIP_CLEANUP) {
    log("\n=== CLEANUP ===");
    await cleanup();
    log("Dropped both scratch tables, the write role (and everything it owned), and the mysql source scratch table.");
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
