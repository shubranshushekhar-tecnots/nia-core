/**
 * REAL-INFRASTRUCTURE smoke test: a real hosted Supabase Postgres (source)
 * -> a real hosted (non-Supabase) Postgres (destination), through the same
 * proposeCleaning() / applyCleaningDiff() / runEtl() pipeline
 * clean-propose-smoke.ts and clean-propose-postgres-dest-smoke.ts already
 * prove against local sandbox containers — but this time using ONLY the
 * limited roles a real customer would actually hand Nia, against tables the
 * user provisioned themselves. This script never creates, drops, or grants
 * anything on either remote database — it only reads/writes through the
 * exact roles it's given.
 *
 * Not committed — ad hoc verification script per the task's instruction
 * ("Don't commit the script until I've seen the results.").
 *
 * ============================ SAFETY ============================
 * - Credentials are read ONLY from TEST_SRC_URL (read-only role connection
 *   string) and TEST_DEST_URL (write role connection string) — both full
 *   Postgres connection strings, env or apps/worker/.env (gitignored).
 *   Never logged, never written to a file. Every error is passed through
 *   redact() before printing, which strips both URLs (and therefore their
 *   embedded passwords) verbatim.
 * - This script never issues CREATE/DROP/GRANT against either remote
 *   database. Source table: public.nia_test_orders (read only). Destination
 *   tables: public.nia_test_orders_raw / public.nia_test_orders_clean
 *   (read/write through the pipeline, plus direct reads here for
 *   verification). Nothing else is touched.
 * - TLS is forced on (`ssl: { rejectUnauthorized: true }`) for every
 *   connection THIS SCRIPT makes directly (verification queries). A
 *   certificate error is never swallowed or retried without TLS — it just
 *   propagates to main()'s catch handler and the script stops.
 * - If a run fails its automatic /preflight check (missing privilege on the
 *   write role), the script stops immediately and prints the exact GRANT
 *   SQL the preflight response names — it never tries to work around a
 *   missing privilege itself.
 * - App metadata (org/connections/projects/workflows/write_grants/
 *   clean_plans) lives in the LOCAL Supabase dev stack, same as every other
 *   *-smoke.ts script, and is safe for this script to create/reuse/replace
 *   freely — that's scratch state, not the customer's real infra.
 *
 * ============================ TWO-PHASE RUN ============================
 * PHASE=1 (default): seeds/reuses app metadata, runs CHECK 1 (plain copy
 *   x2) and CHECK 2 (cleaning), then stops and prints the exact SQL to
 *   manually insert the drift row into the source table (the read-only
 *   source role can't insert it itself).
 * PHASE=2: run after you've inserted that row. Looks up the cleaning
 *   workflow CHECK 1/2 already created and re-runs it once for CHECK 3
 *   (drift refusal). Does not re-seed or re-propose anything.
 *
 * Run with (from apps/worker/):
 *   TEST_SRC_URL=... TEST_DEST_URL=... npx tsx scripts/real-supabase-to-postgres-smoke.ts
 *   TEST_SRC_URL=... TEST_DEST_URL=... PHASE=2 npx tsx scripts/real-supabase-to-postgres-smoke.ts
 * (also reads apps/worker/.env for SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/
 * CONNECTOR_DEV_HOST/REDIS_URL/an LLM provider key via dotenv/config,
 * transitively through supabaseClient.js/env.js, same as every other
 * *-smoke.ts script.)
 *
 * Prerequisites (not started by this script):
 *   - `supabase start` (local app-metadata stack — org/workflow/
 *     connections/clean_plans tables, NOT the source or destination DB).
 *   - `docker compose up -d --build redis connector-supabase` (the
 *     connector-supabase container must be able to reach the real hosted
 *     source/destination hosts over the network).
 *   - apps/web/.env.local (or `supabase status`) for SUPABASE_ANON_KEY.
 *   - TEST_SRC_URL / TEST_DEST_URL set (env or apps/worker/.env, which is
 *     gitignored) — full Postgres connection strings for the two
 *     pre-existing, pre-provisioned roles (read-only on the source table;
 *     read/write — including CREATE on the destination database/`nia`
 *     schema for staged writes — on the destination tables).
 *   - The source table public.nia_test_orders and destination tables
 *     public.nia_test_orders_raw / public.nia_test_orders_clean already
 *     exist, created and populated by the user (8 rows, id 1-8, row 6's
 *     `amount` unparseable, matching the same dirty-data shape this
 *     script's EXPECTED_* tables below describe).
 */
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

// ============================================================
// Credentials — read ONLY here, never logged.
// ============================================================
const TEST_SRC_URL = process.env.TEST_SRC_URL;
const TEST_DEST_URL = process.env.TEST_DEST_URL;
if (!TEST_SRC_URL) throw new Error("TEST_SRC_URL must be set (see this script's header comment).");
if (!TEST_DEST_URL) throw new Error("TEST_DEST_URL must be set (see this script's header comment).");

const PHASE = process.env.PHASE === "2" ? 2 : 1;

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
const ORG_SLUG = "icecream-co";

// ============================================================
// Redaction — every value below is stripped from any printed error.
// ============================================================
const SECRETS: string[] = [TEST_SRC_URL, TEST_DEST_URL];

function redact(text: string): string {
  let out = text;
  for (const secret of SECRETS) {
    if (secret) out = out.split(secret).join("<redacted>");
  }
  // Belt-and-suspenders: also strip the credentials segment of any
  // postgres://user:pass@ URL that slips through unredacted above.
  return out.replace(/:\/\/[^@\s/]+@/g, "://<redacted>@");
}

function redactError(err: unknown): string {
  return redact(err instanceof Error ? (err.stack ?? err.message) : String(err));
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(redact(msg));
}

let failures = 0;
function assert(label: string, cond: boolean, detail?: unknown): boolean {
  if (cond) {
    log(`  PASS  ${label}`);
  } else {
    failures++;
    log(`  FAIL  ${label} ${detail !== undefined ? redact(JSON.stringify(detail)) : ""}`);
  }
  return cond;
}

function stopForPreflightFailure(context: string, message: string): never {
  log(`\n=== STOPPED: ${context} failed its automatic preflight check ===`);
  log(message);
  log("\nRun the GRANT statement(s) named above against the destination database yourself, then re-run this script.");
  process.exit(1);
}

// ============================================================
// Connection-string parsing — TEST_SRC_URL/TEST_DEST_URL are already the
// exact login credentials to use; no reconstruction needed (unlike a
// pooler-username-vs-role-name split, this script never creates a role).
// ============================================================
type ConnInfo = { host: string; port: number; database: string; user: string; password: string };

function parseConnUrl(raw: string): ConnInfo {
  const u = new URL(raw);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    database: u.pathname.replace(/^\//, "") || "postgres",
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  };
}

const SRC_CONN = parseConnUrl(TEST_SRC_URL);
const DEST_CONN = parseConnUrl(TEST_DEST_URL);

// ============================================================
// Fixed naming — the source/destination tables already exist (user-
// provisioned), so nothing here is per-run-suffixed. Re-running PHASE=1
// deletes and recreates only the LOCAL app-metadata scratch objects below
// (projects/workflows), never anything on the two remote databases.
// ============================================================
const SRC_TABLE = "nia_test_orders";
const DEST_RAW_TABLE = "nia_test_orders_raw";
const DEST_CLEAN_TABLE = "nia_test_orders_clean";
const SRC_HANDLE = "@supabase-real-src-test";
const DEST_HANDLE = "@postgres-real-dest-test";
const PLAIN_WORKFLOW_NAME = "Real smoke plain copy (real infra)";
const CLEAN_WORKFLOW_NAME = "Real smoke cleaning (real infra)";

// Expected shape of the data the user pre-seeded into SRC_TABLE — used only
// for comparison in assertions below, never inserted by this script.
const EXPECTED_SOURCE_ROWS: Array<[number, string, string, string, string, string]> = [
  [1, "Asha", "$1,200.50", "2026-03-04", "true", "02134"],
  [2, "Ben", "980", "2026-03-05", "false", "10001"],
  [3, "Chen", "N/A", "2026-03-06", "1", "02139"],
  [4, "Dana", "45.10", "", "0", "94105"],
  [5, "Eli", "$75", "2026-03-08", "true", "00501"],
  [6, "Farah", "abc", "2026-03-09", "false", "60601"],
  [7, "Gus", "1,050", "-", "true", "30301"],
  [8, "Hana", "  ", "2026-03-11", "0", "02110"],
];
const DRIFT_ROW: [number, string, string, string, string, string] = [9, "Ivy", "300", "09/03/2026", "true", "02115"];

// ============================================================
// Host pg helpers — direct verification reads only, via the SAME roles
// the app uses (TEST_SRC_URL / TEST_DEST_URL). No admin access, no DDL.
// ============================================================
async function withPg<T>(connString: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: connString, ssl: { rejectUnauthorized: true } });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function withSrcPg<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  return withPg(TEST_SRC_URL!, fn);
}

async function withDestPg<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  return withPg(TEST_DEST_URL!, fn);
}

// ============================================================
// App-metadata seeding/reuse (local Supabase dev stack only).
// ============================================================
async function getOrgId(): Promise<string> {
  const { data, error } = await supabaseAdmin.from("organizations").select("id").eq("slug", ORG_SLUG).single();
  if (error || !data) throw new Error(`Could not find seed.sql's demo org: ${error?.message}`);
  return data.id as string;
}

async function createVaultSecret(user: string, password: string): Promise<string> {
  const { data, error } = await supabaseAdmin.rpc("create_connector_secret", { p_secret: { user, password } });
  if (error || !data) throw new Error(`vault write failed: ${error?.message}`);
  return data as string;
}

async function ensureConnectorInstalled(orgId: string, connectorId: "supabase" | "postgres"): Promise<void> {
  const { count } = await supabaseAdmin
    .from("connector_installs")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("connector_id", connectorId);
  if (!count) {
    const { error } = await supabaseAdmin
      .from("connector_installs")
      .insert({ org_id: orgId, connector_id: connectorId, installed_by_user_id: DEMO_USER_ID });
    if (error) throw new Error(`install ${connectorId} failed: ${error.message}`);
  }
}

async function ensureConnection(
  orgId: string,
  connectorId: "supabase" | "postgres",
  handle: string,
  config: Record<string, unknown>,
  vaultRef: string,
): Promise<string> {
  const { data: existing, error: findError } = await supabaseAdmin
    .from("connections")
    .select("id")
    .eq("org_id", orgId)
    .eq("handle", handle)
    .maybeSingle();
  if (findError) throw new Error(`connection lookup for ${handle} failed: ${findError.message}`);
  if (existing) return existing.id as string;

  await ensureConnectorInstalled(orgId, connectorId);
  const { data, error } = await supabaseAdmin
    .from("connections")
    .insert({
      org_id: orgId,
      owner_id: null,
      connector_id: connectorId,
      handle,
      display_name: `Real ${connectorId} smoke (fixed)`,
      owner_user_id: DEMO_USER_ID,
      config,
      vault_secret_ref: vaultRef,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`connection insert for ${connectorId} failed: ${error?.message}`);
  return data.id as string;
}

async function ensureWriteGrant(orgId: string, supabaseUser: ReturnType<typeof createClient>, destConnId: string): Promise<string> {
  const { data: existing, error: findError } = await supabaseAdmin
    .from("write_grants")
    .select("id")
    .eq("connection_id", destConnId)
    .not("confirmed_at", "is", null)
    .is("revoked_at", null)
    .order("granted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (findError) throw new Error(`write_grants lookup failed: ${findError.message}`);
  if (existing) return existing.id as string;

  const destWriteVaultRef = await createVaultSecret(DEST_CONN.user, DEST_CONN.password);
  const { data: grantRow, error: grantError } = await supabaseUser.rpc("create_write_grant", {
    p_connection_id: destConnId,
    p_scope: { schemas: ["public", "nia"] },
  });
  if (grantError || !grantRow) throw new Error(`create_write_grant failed: ${grantError?.message}`);
  const grantId = (grantRow as { id: string }).id;
  const { error: confirmError } = await supabaseUser.rpc("confirm_write_grant", {
    p_grant_id: grantId,
    p_write_credential_vault_ref: destWriteVaultRef,
  });
  if (confirmError) throw new Error(`confirm_write_grant failed: ${confirmError.message}`);
  return grantId;
}

async function deleteProjectIfExists(orgId: string, name: string): Promise<void> {
  const { data, error: findError } = await supabaseAdmin.from("projects").select("id").eq("org_id", orgId).eq("name", name).maybeSingle();
  if (findError) throw new Error(`project lookup for "${name}" failed: ${findError.message}`);
  if (!data) return;
  const { error } = await supabaseAdmin.from("projects").delete().eq("id", data.id);
  if (error) throw new Error(`failed to delete stale project "${name}": ${error.message}`);
}

async function createWorkflowGraph(orgId: string, name: string, graph: GraphDoc): Promise<{ workflowId: string }> {
  const { data: project, error: projectError } = await supabaseAdmin
    .from("projects")
    .insert({ org_id: orgId, name, created_by: DEMO_USER_ID })
    .select("id")
    .single();
  if (projectError || !project) throw new Error(`project insert failed: ${projectError?.message}`);

  const { data: workflow, error: workflowError } = await supabaseAdmin
    .from("workflows")
    .insert({ project_id: project.id as string, org_id: orgId, name, created_by: DEMO_USER_ID })
    .select("id")
    .single();
  if (workflowError || !workflow) throw new Error(`workflow insert failed: ${workflowError?.message}`);
  const workflowId = workflow.id as string;

  const { error } = await supabaseAdmin.from("workflow_graphs").insert({ workflow_id: workflowId, graph });
  if (error) throw new Error(`workflow_graphs insert failed: ${error.message}`);

  return { workflowId };
}

async function findWorkflowIdByName(orgId: string, name: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.from("workflows").select("id").eq("org_id", orgId).eq("name", name).maybeSingle();
  if (error) throw new Error(`workflow lookup for "${name}" failed: ${error.message}`);
  return data ? (data.id as string) : null;
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
  const { data, error } = await supabaseAdmin.from("workflow_runs").select("status, rows_processed").eq("id", runId).single();
  if (error || !data) throw new Error(`workflow_runs read failed: ${error?.message}`);
  return data as { status: string; rows_processed: number };
}

async function runEtlToCompletion(workflowId: string, orgId: string, scope: WorkspaceScope): Promise<{ runId: string; result: Awaited<ReturnType<typeof runEtl>> }> {
  const runId = await createRun(workflowId, orgId);
  let job: EtlRunJob = {
    kind: "etl_run",
    scope,
    workflowId,
    runId,
    nodeId: "dest",
    cursor: null,
    chunkSize: 100,
    triggeredByUserId: DEMO_USER_ID,
  };
  let result: Awaited<ReturnType<typeof runEtl>>;
  // Mirrors plain-postgres-extract-smoke.ts's chunk loop: the next job is
  // whatever runEtl actually queued (via the stubbed Queue), not a
  // locally-guessed cursor.
  do {
    const captured: EtlRunJob[] = [];
    result = await runEtl(job, queueStub(captured));
    if (result.status === "chunk") {
      const next = captured[captured.length - 1];
      if (!next) throw new Error("expected a next-chunk job to be enqueued for a 'chunk' result");
      job = next;
    }
  } while (result.status === "chunk");
  return { runId, result };
}

// ============================================================
// Verification reads.
// ============================================================
type RawDestRow = { id: string; customer: string; amount: string; order_date: string; paid: string; zip: string };
type CleanDestRow = { id: number; customer: string | null; amount: number | null; order_date: string | null; paid: boolean | null; zip: string | null };

async function readRawDestRows(): Promise<RawDestRow[]> {
  return withDestPg(async (client) => {
    const { rows } = await client.query(`select id, customer, amount, order_date, paid, zip from ${DEST_RAW_TABLE} order by id`);
    return rows as RawDestRow[];
  });
}

async function readCleanDestRows(): Promise<CleanDestRow[]> {
  return withDestPg(async (client) => {
    const { rows } = await client.query(`select id, customer, amount, order_date, paid, zip from ${DEST_CLEAN_TABLE} order by id`);
    return rows as CleanDestRow[];
  });
}

async function readSourceRows(): Promise<Array<{ id: number; customer: string; amount: string; order_date: string; paid: string; zip: string }>> {
  return withSrcPg(async (client) => {
    const { rows } = await client.query(`select id, customer, amount, order_date, paid, zip from ${SRC_TABLE} order by id`);
    return rows;
  });
}

async function readQuarantineRows(runId: string): Promise<Record<string, unknown>[]> {
  return withDestPg(async (client) => {
    const { rows } = await client.query(`select * from nia.nia_quarantine where run_id = $1 and status = 'committed'`, [runId]);
    return rows as Record<string, unknown>[];
  });
}

async function readStagingTableNames(): Promise<string[]> {
  return withDestPg(async (client) => {
    const { rows } = await client.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'nia' and c.relname like 'nia_stg_%'`,
    );
    return (rows as Array<{ relname: string }>).map((r) => r.relname);
  });
}

// ============================================================
// Inline replica of copilotDiffApply.ts's applyPlanDiff — identical to
// clean-propose-smoke.ts's own copy (see that file's header comment for
// why this is duplicated rather than cross-app imported).
// ============================================================
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

// ============================================================
// Graph builders.
// ============================================================
function buildRawGraph(sourceConnId: string, destConnId: string): GraphDoc {
  const rawMapping = {
    version: 1,
    entries: [
      { from: "id", to: "id" },
      { from: "customer", to: "customer" },
      { from: "amount", to: "amount" },
      { from: "order_date", to: "order_date" },
      { from: "paid", to: "paid" },
      { from: "zip", to: "zip" },
    ],
    approvedAt: new Date().toISOString(),
  };
  return {
    nodes: [
      {
        id: "src",
        type: "source",
        manifestId: "supabase",
        connectionId: sourceConnId,
        position: { x: 0, y: 0 },
        config: { operation: "read", entity: { namespace: "public", name: SRC_TABLE } },
      },
      {
        id: "dest",
        type: "destination",
        manifestId: "postgres",
        connectionId: destConnId,
        position: { x: 200, y: 0 },
        config: {
          operation: "insert",
          entity: { namespace: "public", name: DEST_RAW_TABLE },
          mapping: rawMapping,
          upsertKeys: ["id"],
          // writeMode deliberately absent — defaults to "staged".
        },
      },
    ],
    edges: [{ id: "e0", source: "src", target: "dest" }],
  };
}

function buildCleanGraph(sourceConnId: string, destConnId: string): GraphDoc {
  const cleanMapping = {
    version: 1,
    entries: [
      { from: "id", to: "id" },
      { from: "customer", to: "customer" },
      { from: "amount", to: "amount" },
      { from: "order_date", to: "order_date" },
      { from: "paid", to: "paid" },
      { from: "zip", to: "zip" },
    ],
    approvedAt: new Date().toISOString(),
  };
  return {
    nodes: [
      {
        id: "src",
        type: "source",
        manifestId: "supabase",
        connectionId: sourceConnId,
        position: { x: 0, y: 0 },
        config: { operation: "read", entity: { namespace: "public", name: SRC_TABLE } },
      },
      { id: "transform", type: "transform", position: { x: 200, y: 0 }, config: { steps: [] } },
      {
        id: "dest",
        type: "destination",
        manifestId: "postgres",
        connectionId: destConnId,
        position: { x: 400, y: 0 },
        config: {
          operation: "insert",
          entity: { namespace: "public", name: DEST_CLEAN_TABLE },
          mapping: cleanMapping,
          upsertKeys: ["id"],
        },
      },
    ],
    edges: [
      { id: "e0", source: "src", target: "transform" },
      { id: "e1", source: "transform", target: "dest" },
    ],
  };
}

// ============================================================
// main
// ============================================================
async function seedAppMetadata(): Promise<{ orgId: string; scope: WorkspaceScope; sourceConnId: string; destConnId: string; supabaseUser: ReturnType<typeof createClient> }> {
  const orgId = await getOrgId();
  const scope: WorkspaceScope = { orgId };

  const srcVaultRef = await createVaultSecret(SRC_CONN.user, SRC_CONN.password);
  const sourceConnId = await ensureConnection(
    orgId,
    "supabase",
    SRC_HANDLE,
    { host: SRC_CONN.host, port: SRC_CONN.port, database: SRC_CONN.database, ssl: true },
    srcVaultRef,
  );

  const destReadVaultRef = await createVaultSecret(DEST_CONN.user, DEST_CONN.password);
  const destConnId = await ensureConnection(
    orgId,
    "postgres",
    DEST_HANDLE,
    { host: DEST_CONN.host, port: DEST_CONN.port, database: DEST_CONN.database, ssl: true },
    destReadVaultRef,
  );
  log(`Connections: source=${sourceConnId} (supabase, ${SRC_HANDLE}) dest=${destConnId} (postgres, ${DEST_HANDLE})`);

  const supabaseUser = createClient(SUPABASE_URL, ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signInError } = await supabaseUser.auth.signInWithPassword({ email: DEMO_EMAIL, password: DEMO_PASSWORD });
  if (signInError) throw new Error(`sign-in as demo user failed: ${signInError.message}`);

  const grantId = await ensureWriteGrant(orgId, supabaseUser, destConnId);
  log(`Write grant active: ${grantId}`);

  return { orgId, scope, sourceConnId, destConnId, supabaseUser };
}

async function runPhase1(): Promise<void> {
  log("=== PHASE 1: CHECK 1 (plain copy) + CHECK 2 (cleaning) ===");
  const { orgId, scope, sourceConnId, destConnId, supabaseUser } = await seedAppMetadata();

  await deleteProjectIfExists(orgId, PLAIN_WORKFLOW_NAME);
  await deleteProjectIfExists(orgId, CLEAN_WORKFLOW_NAME);

  // =====================================================================
  // CHECK 1: plain copy, no transform, run twice.
  // =====================================================================
  log("\n=== CHECK 1: plain copy (source -> raw table, no transform) ===");
  const { workflowId: rawWorkflowId } = await createWorkflowGraph(orgId, PLAIN_WORKFLOW_NAME, buildRawGraph(sourceConnId, destConnId));

  for (const attempt of [1, 2]) {
    log(`\n-- plain copy run #${attempt} --`);
    const { runId, result } = await runEtlToCompletion(rawWorkflowId, orgId, scope);
    if (result.status === "failed" && /^Preflight check failed:/.test(result.message ?? "")) {
      stopForPreflightFailure(`plain copy run #${attempt}`, result.message!);
    }
    assert(`run #${attempt}: status 'done'`, result.status === "done", result);
    const run = await getRunStatus(runId);
    assert(`run #${attempt}: workflow_runs.status succeeded`, run.status === "succeeded", run);

    const sourceRows = await readSourceRows();
    const destRows = await readRawDestRows();
    assert(`run #${attempt}: 8 rows in raw destination`, destRows.length === 8, destRows.length);
    const valuesMatch = destRows.every((r, i) => {
      const s = sourceRows[i];
      return s && String(r.id) === String(s.id) && r.customer === s.customer && r.amount === s.amount && r.order_date === s.order_date && r.paid === s.paid && r.zip === s.zip;
    });
    assert(`run #${attempt}: raw destination values identical to source`, valuesMatch, destRows);

    const staging = await readStagingTableNames();
    assert(`run #${attempt}: no nia_stg_* tables left`, staging.length === 0, staging);
  }

  // =====================================================================
  // CHECK 2: cleaning pipeline into the typed clean table.
  // =====================================================================
  log("\n=== CHECK 2: cleaning (proposeCleaning -> apply -> staged runEtl) ===");
  const { workflowId: cleanWorkflowId } = await createWorkflowGraph(orgId, CLEAN_WORKFLOW_NAME, buildCleanGraph(sourceConnId, destConnId));

  log("\n-- proposeCleaning --");
  const proposal = await proposeCleaning(cleanWorkflowId, "transform", scope, DEMO_USER_ID);
  if (!proposal.ok) throw new Error(`proposeCleaning failed: ${proposal.error.kind} ${proposal.error.message}`);
  assert("proposeCleaning: ok", proposal.ok === true, proposal);
  assert("proposeCleaning: at least one step proposed", proposal.value.diff.ops.length > 0, proposal.value.columns);
  log(
    `  proposed ${proposal.value.diff.ops.length} step(s): ${proposal.value.columns.map((c) => `${c.column}(${c.specialist},included=${c.included})`).join(", ")}`,
  );
  const zipColumn = proposal.value.columns.find((c) => c.column === "zip");
  assert("proposeCleaning: zip skipped as identifier-like", !zipColumn || zipColumn.included === false, zipColumn);

  log("\n-- apply diff --");
  await applyCleaningDiff(supabaseUser, cleanWorkflowId, "transform", proposal.value.diff, proposal.value.binding);
  const { count: cleanPlanCount } = await supabaseAdmin
    .from("clean_plans")
    .select("id", { count: "exact", head: true })
    .eq("workflow_id", cleanWorkflowId)
    .eq("node_id", "transform");
  assert("clean_plans binding row written", cleanPlanCount === 1, cleanPlanCount);

  log("\n-- staged runEtl into clean table --");
  const { runId: cleanRunId, result: cleanResult } = await runEtlToCompletion(cleanWorkflowId, orgId, scope);
  if (cleanResult.status === "failed" && /^Preflight check failed:/.test(cleanResult.message ?? "")) {
    stopForPreflightFailure("cleaning run", cleanResult.message!);
  }
  assert("cleaning run: status 'done'", cleanResult.status === "done", cleanResult);
  const cleanRun = await getRunStatus(cleanRunId);
  assert("cleaning run: workflow_runs.status succeeded", cleanRun.status === "succeeded", cleanRun);

  const cleanRows = await readCleanDestRows();
  assert("cleaning: 7 destination rows (row 6 'abc' quarantined)", cleanRows.length === 7, cleanRows);
  assert("cleaning: row id=6 absent", !cleanRows.some((r) => r.id === 6), cleanRows.map((r) => r.id));

  const zipsPreserved = cleanRows.every((r) => {
    const source = EXPECTED_SOURCE_ROWS.find((s) => s[0] === r.id);
    return source && r.zip === source[5];
  });
  assert("cleaning: zip values unchanged, leading zeros preserved", zipsPreserved, cleanRows.map((r) => ({ id: r.id, zip: r.zip })));

  const expectedAmounts: Record<number, number | null> = { 1: 1200.5, 2: 980, 3: null, 4: 45.1, 5: 75, 7: 1050, 8: null };
  const amountsOk = cleanRows.every((r) => {
    if (!(r.id in expectedAmounts)) return true;
    const expected = expectedAmounts[r.id];
    const actual = r.amount === null ? null : Number(r.amount);
    return expected === null ? actual === null : actual === expected;
  });
  assert(
    "cleaning: amount coerced ($1,200.50->1200.50, N/A/blank->NULL, 1,050->1050)",
    amountsOk,
    cleanRows.map((r) => ({ id: r.id, amount: r.amount })),
  );

  const datesOk = cleanRows.every((r) => {
    if (r.id === 4 || r.id === 7) return r.order_date === null;
    return r.order_date !== null;
  });
  assert("cleaning: order_date blank/'-' -> NULL, others preserved", datesOk, cleanRows.map((r) => ({ id: r.id, order_date: r.order_date })));

  const expectedPaid: Record<number, boolean> = { 1: true, 2: false, 3: true, 4: false, 5: true, 7: true, 8: false };
  const paidOk = cleanRows.every((r) => !(r.id in expectedPaid) || r.paid === expectedPaid[r.id]);
  assert("cleaning: paid coerced to booleans", paidOk, cleanRows.map((r) => ({ id: r.id, paid: r.paid })));

  const quarantineRows = await readQuarantineRows(cleanRunId);
  assert("cleaning: exactly 1 committed quarantine row for this run", quarantineRows.length === 1, quarantineRows);
  if (quarantineRows[0]) {
    const sourceRow = JSON.stringify(quarantineRows[0].source_row ?? {});
    assert("cleaning: quarantine row references the 'abc' input", sourceRow.includes("abc"), quarantineRows[0]);
  }

  log(`\n${failures === 0 ? "PHASE 1: ALL PASSED" : `PHASE 1: ${failures} FAILURE(S)`}`);

  const driftSql = `insert into public.${SRC_TABLE} (id, customer, amount, order_date, paid, zip) values (${DRIFT_ROW[0]}, '${DRIFT_ROW[1]}', '${DRIFT_ROW[2]}', '${DRIFT_ROW[3]}', '${DRIFT_ROW[4]}', '${DRIFT_ROW[5]}');`;
  log("\n=== NEXT STEP ===");
  log("Insert the drift row yourself (TEST_SRC_URL's role is read-only, so this script can't do it). Run against the SOURCE database:");
  log(`  ${driftSql}`);
  log("Then tell me it's inserted and re-run this script with PHASE=2 to run CHECK 3 (drift refusal).");

  process.exit(failures === 0 ? 0 : 1);
}

async function runPhase2(): Promise<void> {
  log("=== PHASE 2: CHECK 3 (drift refusal) ===");
  const orgId = await getOrgId();
  const scope: WorkspaceScope = { orgId };

  const cleanWorkflowId = await findWorkflowIdByName(orgId, CLEAN_WORKFLOW_NAME);
  if (!cleanWorkflowId) {
    throw new Error(`No workflow named "${CLEAN_WORKFLOW_NAME}" found — run PHASE=1 first.`);
  }

  const rowsBeforeDrift = await readCleanDestRows();
  assert("pre-drift: 7 destination rows still present (sanity check before re-running)", rowsBeforeDrift.length === 7, rowsBeforeDrift.map((r) => r.id));

  const { runId: driftRunId, result: driftResult } = await runEtlToCompletion(cleanWorkflowId, orgId, scope);
  assert("drift run: status 'failed' (refused before any write)", driftResult.status === "failed", driftResult);
  const driftMessage = driftResult.status === "failed" ? driftResult.message ?? "" : "";
  assert(
    "drift run: refused citing the profile_hash binding (data-shape drift), not schema/version",
    /different data shape/i.test(driftMessage),
    driftMessage,
  );
  const driftRun = await getRunStatus(driftRunId);
  assert("drift run: workflow_runs.status failed, not succeeded", driftRun.status === "failed", driftRun);

  const rowsAfterDrift = await readCleanDestRows();
  assert(
    "drift run: destination unchanged (still 7 rows, no id=9)",
    rowsAfterDrift.length === 7 && !rowsAfterDrift.some((r) => r.id === 9),
    rowsAfterDrift.map((r) => r.id),
  );

  log(`\n${failures === 0 ? "PHASE 2: ALL PASSED" : `PHASE 2: ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

async function main(): Promise<void> {
  if (PHASE === 1) {
    await runPhase1();
  } else {
    await runPhase2();
  }
}

main().catch((err) => {
  console.error(redactError(err));
  process.exit(1);
});
