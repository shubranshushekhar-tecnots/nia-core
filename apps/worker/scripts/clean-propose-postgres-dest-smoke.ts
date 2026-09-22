/**
 * Live smoke test for the new "postgres" connector catalog entry (sibling of
 * "supabase", same connector-supabase:4030 service, distinct connector_id) —
 * proves it round-trips through the real Phase 13 cleaning pipeline exactly
 * like clean-propose-smoke.ts's mysql-destination version, but with BOTH
 * source and destination pointed at the same physical dev-postgres sandbox
 * container: source via the existing "supabase" kind, destination via the
 * NEW "postgres" kind (separate table + separate write role), proving the
 * new manifest dispatches real reads, a real proposeCleaning() LLM round
 * trip, a real diff-apply, and a real staged runEtl() write — including
 * hitting connector-supabase's /preflight nia-schema guard on a genuine
 * write dispatch made through the new catalog entry.
 *
 * Not committed — ad hoc verification script per the task's instruction.
 *
 * Run with (from apps/worker/):
 *   npx tsx scripts/clean-propose-postgres-dest-smoke.ts
 * (reads apps/worker/.env for SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/
 * CONNECTOR_DEV_HOST/REDIS_URL/an LLM provider key via dotenv/config, same
 * as clean-propose-smoke.ts.)
 *
 * Prerequisites (not started by this script):
 *   - `supabase start` (applies migrations, incl. 0024's clean_plans table)
 *   - `docker compose up -d --build redis dev-postgres connector-supabase`
 *     (mysql/connector-mysql not needed — destination moves to postgres).
 *   - apps/web/.env.local (or supabase status) for SUPABASE_ANON_KEY, used
 *     to sign in as seed.sql's demo user for write-grant + apply RPCs.
 *
 * This script runs on the HOST: it reaches dev-postgres via its
 * host-published port (5433) for direct seeding/verification of BOTH the
 * source and destination tables, while the connector-supabase CONTAINER
 * reaches the same database via the compose service name (dev-postgres:5432)
 * through both connection rows' `config` — same duality as
 * clean-propose-smoke.ts/write-smoke-staged.ts.
 */
import { createHash } from "node:crypto";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import type { Queue } from "bullmq";
import {
  ADAPTER_VERSION,
  OP_CATALOG_VERSION,
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

// Dialed by the connector-supabase CONTAINER, over the compose network —
// both source and destination point at the same physical sandbox Postgres,
// distinguished only by connector_id ("supabase" vs the new "postgres").
const PG_CONTAINER_CONFIG = { host: "dev-postgres", port: 5432, database: "sandbox" };
// Dialed by THIS script, from the host, for provisioning + verification.
const HOST_PG = { host: "localhost", port: 5433, database: "sandbox", user: "postgres", password: "devroot" };

const SOURCE_TABLE = "clean_smoke_pg_source";
const DEST_TABLE = "clean_smoke_pg_dest";
const WRITE_ROLE_USER = "nia_clean_smoke_pg";
const WRITE_ROLE_PASSWORD = "nia_clean_smoke_pg_pw";

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
  await withHostPg(async (client) => {
    // --- Source: dev-postgres, public schema. nia_ro already has blanket
    // SELECT (docker/dev-postgres-init.sql's default-privileges grant) —
    // no new grants needed for a freshly-created table. ---
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

    // --- Destination: dev-postgres, public schema, staged mode, via the
    // NEW "postgres" catalog entry's own dedicated write role — separate
    // from the source's read-only nia_ro. Grants mirror write-smoke-
    // staged.ts's proven pattern for a connector-supabase write
    // destination. ---
    await client.query(`drop table if exists ${DEST_TABLE}`);
    await client.query(`
      create table ${DEST_TABLE} (
        id int primary key,
        status_raw text,
        amount_raw double precision
      )
    `);
    const { rowCount } = await client.query("select 1 from pg_roles where rolname = $1", [WRITE_ROLE_USER]);
    if (!rowCount) {
      await client.query(`create role ${WRITE_ROLE_USER} with login password '${WRITE_ROLE_PASSWORD}'`);
    }
    await client.query(`grant connect on database sandbox to ${WRITE_ROLE_USER}`);
    // Staged writes create a dedicated "nia" schema on first use — needs
    // CREATE on the database itself, per /preflight's create-schema-nia
    // check.
    await client.query(`grant create on database sandbox to ${WRITE_ROLE_USER}`);
    await client.query(`grant usage on schema public to ${WRITE_ROLE_USER}`);
    await client.query(`grant select, insert, update, delete on ${DEST_TABLE} to ${WRITE_ROLE_USER}`);
    // The "nia" schema may already exist (left behind, superuser-owned,
    // by an earlier smoke script's run against this same sandbox
    // Postgres) — "GRANT CREATE ON DATABASE" only lets a role create a
    // schema that doesn't exist yet, not use one it doesn't own. Grant
    // directly on it too, whenever it's already there.
    const { rows: niaSchema } = await client.query("select 1 from pg_namespace where nspname = 'nia'");
    if (niaSchema.length > 0) {
      await client.query(`grant usage, create on schema nia to ${WRITE_ROLE_USER}`);
    }
  });
}

async function cleanup(): Promise<void> {
  await withHostPg(async (client) => {
    await client.query(`drop table if exists ${SOURCE_TABLE}`);
    await client.query(`drop table if exists ${DEST_TABLE}`);
    const { rowCount } = await client.query("select 1 from pg_roles where rolname = $1", [WRITE_ROLE_USER]);
    if (rowCount) {
      // Also drops the "nia" schema and anything left in it (owned by this
      // role once it creates it) — any staging/quarantine table a failed
      // run left behind gets swept up here too.
      await client.query(`drop owned by ${WRITE_ROLE_USER}`);
      await client.query(`drop role if exists ${WRITE_ROLE_USER}`);
    }
  });
}

async function getOrgId(): Promise<string> {
  const { data, error } = await supabaseAdmin.from("organizations").select("id").eq("slug", "icecream-co").single();
  if (error || !data) throw new Error(`Could not find seed.sql's demo org: ${error?.message}`);
  return data.id as string;
}

async function seedConnection(
  orgId: string,
  connectorId: "supabase" | "postgres",
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
      display_name: `Clean propose postgres-dest smoke (${connectorId})`,
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
    .eq("name", "Clean propose postgres dest smoke")
    .maybeSingle();
  let projectId = existingProject?.id as string | undefined;
  if (!projectId) {
    const { data, error } = await supabaseAdmin
      .from("projects")
      .insert({ org_id: orgId, name: "Clean propose postgres dest smoke", created_by: DEMO_USER_ID })
      .select("id")
      .single();
    if (error || !data) throw new Error(`project insert failed: ${error?.message}`);
    projectId = data.id as string;
  }

  const { data: existingWorkflow } = await supabaseAdmin
    .from("workflows")
    .select("id")
    .eq("project_id", projectId)
    .eq("name", "Clean propose postgres dest smoke")
    .maybeSingle();
  let workflowId = existingWorkflow?.id as string | undefined;
  if (!workflowId) {
    const { data, error } = await supabaseAdmin
      .from("workflows")
      .insert({ project_id: projectId, org_id: orgId, name: "Clean propose postgres dest smoke", created_by: DEMO_USER_ID })
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
        manifestId: "postgres",
        connectionId: destConnId,
        position: { x: 400, y: 0 },
        config: {
          operation: "insert",
          entity: { namespace: "public", name: DEST_TABLE },
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

async function readDestRows(): Promise<DestRow[]> {
  return withHostPg(async (client) => {
    const { rows } = await client.query(`select id, status_raw, amount_raw from ${DEST_TABLE} order by id`);
    return rows as DestRow[];
  });
}

async function readQuarantineRows(runId: string): Promise<Record<string, unknown>[]> {
  return withHostPg(async (client) => {
    const { rows } = await client.query(`select * from nia.nia_quarantine where run_id = $1 and status = 'committed'`, [runId]);
    return rows as Record<string, unknown>[];
  });
}

/**
 * Inline replica of copilotDiffApply.ts's applyPlanDiff — identical to
 * clean-propose-smoke.ts's own copy (see that file's header comment for why
 * this is duplicated rather than cross-app imported).
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
  const sourceConnId = await seedConnection(orgId, "supabase", "clean-smoke-pg-source", PG_CONTAINER_CONFIG);
  const destConnId = await seedConnection(orgId, "postgres", "clean-smoke-pg-dest", PG_CONTAINER_CONFIG);
  log(`Seeded connections: source=${sourceConnId} (supabase) dest=${destConnId} (postgres)`);
  const { workflowId } = await seedWorkflowGraph(orgId, sourceConnId, destConnId);
  log(`Seeded workflow: ${workflowId}`);

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
  // Step 3: Staged run to the NEW "postgres" destination — assert
  // destination values + quarantine (proves the new manifest through
  // dispatch, guardrails, and connector-supabase's /preflight for real).
  // =====================================================================
  log("\n=== STEP 3: staged runEtl (destination via new 'postgres' connector kind) ===");
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

  const destRows = await readDestRows();
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

  const quarantineRows = await readQuarantineRows(runId);
  track(assert("quarantine: exactly 1 committed row for this run", quarantineRows.length === 1, quarantineRows));
  if (quarantineRows[0]) {
    track(assert("quarantine: row references dest table", quarantineRows[0].dest_table === `public.${DEST_TABLE}`, quarantineRows[0]));
  }

  if (!process.env.SKIP_CLEANUP) {
    log("\n=== CLEANUP ===");
    await cleanup();
    log("Dropped scratch tables, write role (and everything it owned in the nia schema).");
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
