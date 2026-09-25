/**
 * Live smoke test for Phase 13, Step 9 item 4 — the CleanPlan pipeline's
 * one required end-to-end proof (docs/plans/phase13.md): a messy sandbox
 * Postgres (via connector-supabase) table -> proposeCleaning() (real LLM
 * specialists, real router, real assembly/dry-run guard) -> apply the
 * resulting PlanDiff to the workflow graph + write the clean_plans binding
 * -> a real staged runEtl() to a mysql destination. Asserts the
 * destination's cleaned values AND the quarantine count.
 *
 * Everything upstream of "apply" is already unit-proven in isolation
 * (router.test.ts, the specialist tests, assemble.test.ts,
 * cleanPlanDrift.test.ts) — this script proves the real wiring across
 * process/module boundaries: a real profiler round trip through
 * connector-supabase, a real (non-mocked) LLM call for both specialists,
 * the diff-apply sequence copilotDiffApply.ts's applyPlanDiff performs
 * (replicated inline here via the same @nia/schemas exports it uses —
 * deliberately NOT importing apps/api code into apps/worker, an
 * unprecedented cross-app boundary this codebase has never crossed; see
 * this file's git history / docs/decisions.md's Phase 13 entry for why),
 * and a real chunked staged runEtl() against a live mysql sandbox.
 *
 * Planted source data (6 rows, two columns) is deliberately engineered to
 * be unambiguous — NOT the eval corpus's edge cases:
 *   - status_raw: "active"/"inactive" plus two literal MISSING_VALUE_TOKENS
 *     entries ("N/A", "-") -> routes to missing-value, specialist's fixed
 *     onFailure "null" nulls both.
 *   - amount_raw: five plain numeric strings plus one genuinely-unparseable
 *     "garbage" (row id=4) -> routes to coercion. The coercion specialist's
 *     onFailure is ALWAYS "quarantine" (a fixed engine default, never
 *     LLM-decided — see coercionSpecialist.ts's header comment), so row 4
 *     is guaranteed to be quarantined and excluded from the destination
 *     regardless of exactly what expression the LLM proposes. Failure rate
 *     is 1/6 (~16.7%), well under assemble.ts's 50% coercion drop guard.
 *
 * Run with (from apps/worker/):
 *   npx tsx scripts/clean-propose-smoke.ts
 * (reads apps/worker/.env for SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/
 * CONNECTOR_DEV_HOST/REDIS_URL/an LLM provider key via dotenv/config,
 * transitively through supabaseClient.js/env.js, same as every other
 * *-smoke.ts script.)
 *
 * Prerequisites (not started by this script):
 *   - `supabase start` (applies migrations, incl. 0024's clean_plans table)
 *   - `redis`/`dev-mysql`/`dev-postgres`/`connector-mysql`/
 *     `connector-supabase` rebuilt+started by `pnpm run smoke:clean`'s
 *     `presmoke:clean` step (`docker compose up -d --build ...`).
 *   - apps/web/.env.local (or supabase status) for SUPABASE_ANON_KEY, used
 *     to sign in as seed.sql's demo user for write-grant + apply RPCs.
 *
 * This script runs on the HOST: it reaches dev-mysql/dev-postgres via
 * their host-published ports (3307/5433) for direct seeding/verification,
 * while the connector-mysql/connector-supabase CONTAINERS reach the same
 * databases via compose service names (dev-mysql:3306, dev-postgres:5432)
 * through the connection rows' `config` — same duality as
 * write-smoke-staged.ts.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import type { Queue } from "bullmq";
import {
  ADAPTER_VERSION,
  OP_CATALOG_VERSION,
  PROFILE_SIGNATURE_VERSION,
  canonicalizeStepsForHash,
  ensureGraphStepIds,
  parseNodeConfig,
  stampDiffStepProvenance,
  validateDiffStructure,
  applyDiffToGraph,
  type EtlRunJob,
  type GraphDoc,
  type PlanDiff,
} from "@nia/schemas";
import { runEtl } from "../src/lib/etl/runEtl.js";
import { proposeCleaning } from "../src/lib/clean/proposeCleaning.js";
import type { WorkspaceScope } from "../src/lib/workspaceScope.js";
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
// Dialed by the connector-supabase CONTAINER, over the compose network.
const SOURCE_CONFIG = { host: "dev-postgres", port: 5432, database: "sandbox" };
// Dialed by the connector-mysql CONTAINER, over the compose network.
const DEST_CONFIG = { host: "dev-mysql", port: 3306, database: "sandbox" };
// Dialed by THIS script, from the host, for provisioning + verification.
const HOST_PG = { host: "localhost", port: 5433, database: "sandbox", user: "postgres", password: "devroot" };

const SOURCE_TABLE = "clean_smoke_source";
const DEST_TABLE = "clean_smoke_dest";
const WRITE_ROLE_USER = "nia_clean_smoke";
const WRITE_ROLE_PASSWORD = "nia_clean_smoke_pw";

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

function mysqlQueryJson<T>(sql: string): T[] {
  const out = execFileSync("docker", [
    "exec",
    MYSQL_CONTAINER,
    "mysql",
    "-uroot",
    "-pdevroot",
    "sandbox",
    "--batch",
    "-e",
    sql,
  ]).toString();
  const lines = out.trim().split("\n");
  if (lines.length <= 1) return [];
  const headers = lines[0]!.split("\t");
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const row = {} as Record<string, string>;
    headers.forEach((h, i) => {
      row[h] = cells[i] === "NULL" ? (null as unknown as string) : cells[i]!;
    });
    return row as T;
  });
}

/** Mirrors stagingRegistry.ts's deriveStagingEntity exactly. */
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

async function provisionSourceAndDest(): Promise<void> {
  // --- Source: dev-postgres, public schema. nia_ro already has blanket
  // SELECT (docker/dev-postgres-init.sql's default-privileges grant) —
  // no new grants needed for a freshly-created table. ---
  await withHostPg(async (client) => {
    await client.query(`drop table if exists ${SOURCE_TABLE}`);
    await client.query(`
      create table ${SOURCE_TABLE} (
        id int primary key,
        status_raw text,
        amount_raw text
      )
    `);
    await client.query(`
      insert into ${SOURCE_TABLE} (id, status_raw, amount_raw) values
        (1, 'active', '1200.50'),
        (2, 'N/A', '45.00'),
        (3, 'inactive', '999'),
        (4, '-', 'garbage'),
        (5, 'active', '1500.25'),
        (6, 'inactive', '300')
    `);
  });

  // --- Destination: dev-mysql, sandbox database, staged mode. Grants per
  // connector-mysql's own /preflight route (services/connector-mysql/src/
  // index.ts): CREATE ON *.* (needed even for an already-existing "nia"
  // database — MySQL still checks the privilege on CREATE DATABASE IF NOT
  // EXISTS), CREATE+DROP on nia.* (staging/quarantine table lifecycle),
  // INSERT/UPDATE/DELETE on the destination table itself. ---
  mysqlExec(`DROP TABLE IF EXISTS ${DEST_TABLE};`);
  mysqlExec(`
    CREATE TABLE ${DEST_TABLE} (
      id INT PRIMARY KEY,
      status_raw VARCHAR(50) NULL,
      amount_raw DOUBLE NULL
    );
  `);
  mysqlExec(`DROP USER IF EXISTS '${WRITE_ROLE_USER}'@'%';`);
  mysqlExec(`CREATE USER '${WRITE_ROLE_USER}'@'%' IDENTIFIED BY '${WRITE_ROLE_PASSWORD}';`);
  mysqlExec(`GRANT CREATE ON *.* TO '${WRITE_ROLE_USER}'@'%';`);
  mysqlExec(`CREATE DATABASE IF NOT EXISTS nia;`);
  mysqlExec(`GRANT CREATE, DROP, SELECT, INSERT, UPDATE, DELETE ON nia.* TO '${WRITE_ROLE_USER}'@'%';`);
  mysqlExec(`GRANT SELECT, INSERT, UPDATE, DELETE ON sandbox.${DEST_TABLE} TO '${WRITE_ROLE_USER}'@'%';`);
  mysqlExec(`FLUSH PRIVILEGES;`);
}

async function cleanup(): Promise<void> {
  await withHostPg(async (client) => {
    await client.query(`drop table if exists ${SOURCE_TABLE}`);
  });
  mysqlExec(`DROP TABLE IF EXISTS ${DEST_TABLE};`);
  mysqlExec(`DROP DATABASE IF EXISTS nia;`);
  mysqlExec(`DROP USER IF EXISTS '${WRITE_ROLE_USER}'@'%';`);
}

async function getOrgId(): Promise<string> {
  const { data, error } = await supabaseAdmin.from("organizations").select("id").eq("slug", "icecream-co").single();
  if (error || !data) throw new Error(`Could not find seed.sql's demo org: ${error?.message}`);
  return data.id as string;
}

async function seedConnection(
  orgId: string,
  connectorId: "mysql" | "supabase",
  handleSuffix: string,
  config: Record<string, unknown>,
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

  const handle = `@${connectorId}-${handleSuffix}`;
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
      display_name: `Clean propose smoke (${connectorId})`,
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
    .eq("name", "Clean propose smoke")
    .maybeSingle();
  let projectId = existingProject?.id as string | undefined;
  if (!projectId) {
    const { data, error } = await supabaseAdmin
      .from("projects")
      .insert({ org_id: orgId, name: "Clean propose smoke", created_by: DEMO_USER_ID })
      .select("id")
      .single();
    if (error || !data) throw new Error(`project insert failed: ${error?.message}`);
    projectId = data.id as string;
  }

  const { data: existingWorkflow } = await supabaseAdmin
    .from("workflows")
    .select("id")
    .eq("project_id", projectId)
    .eq("name", "Clean propose smoke")
    .maybeSingle();
  let workflowId = existingWorkflow?.id as string | undefined;
  if (!workflowId) {
    const { data, error } = await supabaseAdmin
      .from("workflows")
      .insert({ project_id: projectId, org_id: orgId, name: "Clean propose smoke", created_by: DEMO_USER_ID })
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
        id: "transform",
        type: "transform",
        position: { x: 200, y: 0 },
        config: { steps: [] },
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
              { from: "id", to: "id" },
              { from: "status_raw", to: "status_raw" },
              { from: "amount_raw", to: "amount_raw" },
            ],
            approvedAt: new Date().toISOString(),
          },
          upsertKeys: ["id"],
          // writeMode deliberately absent — defaults to "staged".
        },
      },
    ],
    edges: [
      { id: "e0", source: "src", target: "transform" },
      { id: "e1", source: "transform", target: "dest" },
    ],
  };

  // Fresh insert only — a pre-existing row from a previous run would
  // already be at a higher version, which would then disagree with
  // proposeCleaning's freshly-read baseGraphVersion below. Delete first so
  // this script is idempotent across repeated runs.
  await supabaseAdmin.from("workflow_graphs").delete().eq("workflow_id", workflowId);
  const { error } = await supabaseAdmin.from("workflow_graphs").insert({ workflow_id: workflowId, graph });
  if (error) throw new Error(`workflow_graphs insert failed: ${error.message}`);

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

type DestRow = { id: number; status_raw: string | null; amount_raw: number | null };

function readDestRows(): DestRow[] {
  const rows = mysqlQueryJson<{ id: string; status_raw: string | null; amount_raw: string | null }>(
    `SELECT id, status_raw, amount_raw FROM ${DEST_TABLE} ORDER BY id;`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    status_raw: r.status_raw,
    amount_raw: r.amount_raw === null ? null : Number(r.amount_raw),
  }));
}

function readQuarantineRows(runId: string): Record<string, string>[] {
  return mysqlQueryJson<Record<string, string>>(
    `SELECT * FROM nia.nia_quarantine WHERE run_id = '${runId}' AND status = 'committed';`,
  );
}

/**
 * Inline replica of copilotDiffApply.ts's applyPlanDiff, using only
 * @nia/schemas exports plus direct Supabase writes — deliberately not a
 * cross-app import of apps/api code into apps/worker (see this file's
 * header comment). Mirrors that function's exact sequence: fresh fetch +
 * staleness check, ensureGraphStepIds, stamp copilot provenance (same
 * fixed `{source:"copilot", planId}` stamp applyPlanDiff always applies,
 * even over a diff whose steps already carry `specialist` provenance from
 * assemble.ts — that overwrite is real, existing production behavior, not
 * something this script works around), validate, apply, persist (version
 * bump is an unconditional DB trigger — see 0012_workflow_graphs.sql), a
 * copilot_applied_plans row, then the clean_plans binding upsert.
 */
async function applyCleaningDiff(
  supabaseUser: ReturnType<typeof createClient>,
  workflowId: string,
  nodeId: string,
  diff: PlanDiff,
  binding: { sourceSchemaHash: string; profileHash: string },
): Promise<void> {
  const { data: graphRow, error: graphError } = await supabaseUser
    .from("workflow_graphs")
    .select("graph, version")
    .eq("workflow_id", workflowId)
    .single();
  if (graphError || !graphRow) throw new Error(`workflow_graphs read failed: ${graphError?.message}`);
  const currentGraph = graphRow.graph as GraphDoc;
  const currentVersion = graphRow.version as number;

  if (currentVersion !== diff.baseGraphVersion) {
    throw new Error(`baseGraphVersion mismatch: graph is at ${currentVersion}, diff expects ${diff.baseGraphVersion}`);
  }

  const backfilled = ensureGraphStepIds(currentGraph);
  const appliedPlanId = crypto.randomUUID();
  const stamped = stampDiffStepProvenance(diff, { source: "copilot", planId: appliedPlanId });

  const checks = validateDiffStructure(stamped, backfilled);
  const failure = checks.find((c) => c.status === "fail");
  if (failure) throw new Error(`validateDiffStructure failed: ${failure.message}`);

  const nextGraph = applyDiffToGraph(stamped, backfilled);

  const { data: written, error: writeError } = await supabaseUser
    .from("workflow_graphs")
    .update({ graph: nextGraph })
    .eq("workflow_id", workflowId)
    .eq("version", currentVersion)
    .select("version")
    .single();
  if (writeError || !written) throw new Error(`workflow_graphs update failed: ${writeError?.message}`);
  const newVersion = written.version as number;

  const { error: appliedError } = await supabaseUser.from("copilot_applied_plans").insert({
    id: appliedPlanId,
    workflow_id: workflowId,
    summary: stamped.summary,
    prompt: "",
    diff: stamped,
    graph_version_after: newVersion,
  });
  if (appliedError) throw new Error(`copilot_applied_plans insert failed: ${appliedError.message}`);

  const node = nextGraph.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`node ${nodeId} not found in applied graph`);
  const parsed = parseNodeConfig("transform", node.config);
  if (parsed.unrecognized || parsed.type !== "transform") throw new Error(`node ${nodeId} is not a valid transform node`);
  const stepsHash = createHash("sha256").update(JSON.stringify(canonicalizeStepsForHash(parsed.value.steps))).digest("hex");

  const { error: bindingError } = await supabaseUser.from("clean_plans").upsert(
    {
      workflow_id: workflowId,
      node_id: nodeId,
      applied_plan_id: appliedPlanId,
      steps_hash: stepsHash,
      source_schema_hash: binding.sourceSchemaHash,
      profile_hash: binding.profileHash,
      op_catalog_version: OP_CATALOG_VERSION,
      adapter_version: ADAPTER_VERSION,
      profile_signature_version: PROFILE_SIGNATURE_VERSION,
    },
    { onConflict: "workflow_id,node_id" },
  );
  if (bindingError) throw new Error(`clean_plans upsert failed: ${bindingError.message}`);
}

async function main(): Promise<void> {
  let failures = 0;
  const track = (ok: boolean) => {
    if (!ok) failures++;
  };

  log("=== SEEDING (not part of the pipeline proof below) ===");
  await provisionSourceAndDest();
  const orgId = await getOrgId();
  const scope: WorkspaceScope = { orgId };
  const sourceConnId = await seedConnection(orgId, "supabase", "clean-smoke-source", SOURCE_CONFIG);
  const destConnId = await seedConnection(orgId, "mysql", "clean-smoke-dest", DEST_CONFIG);
  log(`Seeded connections: source=${sourceConnId} dest=${destConnId}`);
  const { workflowId } = await seedWorkflowGraph(orgId, sourceConnId, destConnId);
  log(`Seeded workflow: ${workflowId}`);

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

  // =====================================================================
  // Step 1: Propose cleaning (real profiler round trip + real LLM calls)
  // =====================================================================
  log("\n=== STEP 1: proposeCleaning ===");
  const proposal = await proposeCleaning(workflowId, "transform", scope, DEMO_USER_ID);
  if (!proposal.ok) throw new Error(`proposeCleaning failed: ${proposal.error.kind} ${proposal.error.message}`);
  track(assert("proposeCleaning: ok", proposal.ok === true, proposal));
  track(assert("proposeCleaning: at least one step proposed", proposal.value.diff.ops.length > 0, proposal.value.columns));
  log(
    `  proposed ${proposal.value.diff.ops.length} step(s) across columns: ${proposal.value.columns.map((c) => `${c.column}(${c.specialist},included=${c.included})`).join(", ")}`,
  );

  // =====================================================================
  // Step 2: Apply the diff (inline replica of applyPlanDiff)
  // =====================================================================
  log("\n=== STEP 2: apply diff + clean_plans binding ===");
  await applyCleaningDiff(supabaseUser, workflowId, "transform", proposal.value.diff, proposal.value.binding);
  const { data: appliedGraphRow } = await supabaseAdmin.from("workflow_graphs").select("graph").eq("workflow_id", workflowId).single();
  const appliedTransform = (appliedGraphRow!.graph as GraphDoc).nodes.find((n) => n.id === "transform")!;
  const appliedSteps = parseNodeConfig("transform", appliedTransform.config);
  const stepCount = !appliedSteps.unrecognized && appliedSteps.type === "transform" ? appliedSteps.value.steps.length : 0;
  track(assert("applied graph: transform node has the proposed steps", stepCount === proposal.value.diff.ops.length, stepCount));
  const { count: cleanPlanCount } = await supabaseAdmin
    .from("clean_plans")
    .select("id", { count: "exact", head: true })
    .eq("workflow_id", workflowId)
    .eq("node_id", "transform");
  track(assert("clean_plans binding row written", cleanPlanCount === 1, cleanPlanCount));

  // =====================================================================
  // Step 3: Staged run to mysql — assert destination values + quarantine
  // =====================================================================
  log("\n=== STEP 3: staged runEtl ===");
  const runId = await createRun(workflowId, orgId);
  const job: EtlRunJob = {
    kind: "etl_run",
    scope,
    workflowId,
    runId,
    nodeId: "dest",
    cursor: null,
    chunkSize: 10, // 6 source rows -> single chunk
    triggeredByUserId: DEMO_USER_ID,
  };

  const result = await runEtl(job, queueStub([]));
  track(assert("runEtl status 'done'", result.status === "done", result));

  const run = await getRunStatus(runId);
  track(assert("workflow_runs.status: succeeded", run.status === "succeeded", run));

  const destRows = readDestRows();
  const expected: DestRow[] = [
    { id: 1, status_raw: "active", amount_raw: 1200.5 },
    { id: 2, status_raw: null, amount_raw: 45 },
    { id: 3, status_raw: "inactive", amount_raw: 999 },
    { id: 5, status_raw: "active", amount_raw: 1500.25 },
    { id: 6, status_raw: "inactive", amount_raw: 300 },
  ];
  track(assert("destination: exactly 5 rows (id=4 quarantined)", destRows.length === 5, destRows));
  track(assert("destination: ids match exactly (4 excluded)", JSON.stringify(destRows.map((r) => r.id)) === JSON.stringify(expected.map((r) => r.id)), destRows));
  track(
    assert(
      "destination: status_raw missing tokens nulled, other values preserved",
      destRows.every((r) => r.status_raw === expected.find((e) => e.id === r.id)!.status_raw),
      destRows,
    ),
  );
  track(
    assert(
      "destination: amount_raw coerced to numbers",
      destRows.every((r) => r.amount_raw === expected.find((e) => e.id === r.id)!.amount_raw),
      destRows,
    ),
  );

  const quarantineRows = readQuarantineRows(runId);
  track(assert("quarantine: exactly 1 committed row for this run", quarantineRows.length === 1, quarantineRows));
  if (quarantineRows[0]) {
    track(assert("quarantine: row references dest table", quarantineRows[0].dest_table === `sandbox.${DEST_TABLE}`, quarantineRows[0]));
  }

  if (!process.env.SKIP_CLEANUP) {
    log("\n=== CLEANUP ===");
    await cleanup();
    log("Dropped scratch tables, write role/database.");
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
