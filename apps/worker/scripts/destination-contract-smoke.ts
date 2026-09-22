/**
 * Schema-layer Part 4 — live smoke test: mongo nested documents into a
 * brand-new postgres destination table (ensureDestination's CREATE path),
 * proving: (1) the created columns' native types, including a mongo array
 * field collapsed to a single JSONB column, (2) that array's values
 * round-trip as valid JSON, and (3) a row whose `amount_text` fails a
 * fallible transform (to_number) is quarantined — never reaches the
 * destination — while the rest of the run still succeeds.
 *
 * NOT a substitute for destinationContract.test.ts/ensureDestination's own
 * unit coverage of buildDestinationContract/compareContractToExisting in
 * isolation — this script proves the real wiring: a real mongo source
 * (through connector-mongodb's /introspect + flatten.ts), runEtl.ts's
 * Part 4 reordered staged-mode flow (ensureDestination runs before
 * preflight/staging), a real connector-supabase /create-entity CREATE
 * TABLE, and the existing onFailure="quarantine" residual pipeline
 * (composed here, not new machinery — Part 4 has no native type-mismatch
 * detector of its own; that's Part 5's conformance step, per
 * docs/plans/schema-layer.md).
 *
 * Run with (from apps/worker/):
 *   npx tsx scripts/destination-contract-smoke.ts
 *
 * Prerequisites (not started by this script):
 *   - `supabase start`
 *   - `redis`/`dev-mongo`/`dev-postgres`/`connector-mongodb`/
 *     `connector-supabase` rebuilt+started by
 *     `pnpm run smoke:destination-contract`'s presmoke step (always a
 *     fresh connector image — see docs/decisions.md's Phase 11 "stale
 *     image" lesson).
 *   - apps/web/.env.local (or supabase status) for SUPABASE_ANON_KEY.
 *
 * Host/container duality: this script runs on the HOST, reaching
 * dev-mongo/dev-postgres via their host-published ports (27018/5433) for
 * seeding/verification, while the connector-mongodb/connector-supabase
 * CONTAINERS reach the same databases via compose service names
 * (dev-mongo:27017, dev-postgres:5432) through the connections' `config`.
 */
import { MongoClient } from "mongodb";
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

const HOST_MONGO_URI = "mongodb://root:devroot@localhost:27018/sandbox?authSource=admin";
// Dialed by the connector-mongodb CONTAINER, over the compose network.
const CONTAINER_MONGO = { host: "dev-mongo", port: 27017, database: "sandbox" };
// Dialed by THIS script, from the host, for provisioning + verification.
const HOST_PG = { host: "localhost", port: 5433, database: "sandbox", user: "postgres", password: "devroot" };
// Dialed by the connector-supabase CONTAINER, over the compose network.
const CONTAINER_PG = { host: "dev-postgres", port: 5432, database: "sandbox" };

const SRC_COLLECTION = "destcontract_smoke_src";
const DEST_TABLE = "destcontract_smoke_dest";
const WRITE_ROLE_USER = "nia_write_destcontract_smoke";
const WRITE_ROLE_PASSWORD = "nia_write_destcontract_smoke_pw";

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

function assert(label: string, cond: boolean, detail?: unknown): boolean {
  log(`  ${cond ? "PASS" : "FAIL"}  ${label} ${!cond && detail !== undefined ? JSON.stringify(detail) : ""}`);
  return cond;
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

async function withMongo<T>(fn: (db: ReturnType<MongoClient["db"]>) => Promise<T>): Promise<T> {
  const client = new MongoClient(HOST_MONGO_URI);
  await client.connect();
  try {
    return await fn(client.db("sandbox"));
  } finally {
    await client.close();
  }
}

async function seedMongo(): Promise<void> {
  await withMongo(async (db) => {
    await db.collection(SRC_COLLECTION).drop().catch(() => {});
    await db.collection(SRC_COLLECTION).insertMany([
      { id: 1, address: { city: "Springfield", zip: "11111" }, tags: ["a", "b"], amount_text: "12.5" },
      // amount_text is non-numeric here -> to_number(amount_text) fails ->
      // quarantined, never reaches the destination.
      { id: 2, address: { city: "Shelbyville", zip: "22222" }, tags: ["c"], amount_text: "N/A" },
      { id: 3, address: { city: "Ogdenville", zip: "33333" }, tags: ["d", "e", "f"], amount_text: "7" },
    ]);
  });
}

async function provisionRoleAndTable(): Promise<void> {
  await withHostPg(async (client) => {
    await client.query(`drop table if exists ${DEST_TABLE}`);
    const { rowCount } = await client.query("select 1 from pg_roles where rolname = $1", [WRITE_ROLE_USER]);
    if (!rowCount) {
      await client.query(`create role ${WRITE_ROLE_USER} with login password '${WRITE_ROLE_PASSWORD}'`);
    }
    await client.query(`grant connect on database sandbox to ${WRITE_ROLE_USER}`);
    // Needed for ensureDestination's /create-entity to create both the
    // staged-mode "nia" schema (quarantine/staging tables) AND, for THIS
    // smoke test specifically, a brand-new table in "public" — unlike
    // every other write-smoke script (which only ever writes into a table
    // this script pre-creates as postgres admin), this is the first
    // scenario where the write role itself CREATEs the destination table.
    await client.query(`grant create on database sandbox to ${WRITE_ROLE_USER}`);
    await client.query(`grant create, usage on schema public to ${WRITE_ROLE_USER}`);
  });
}

async function cleanup(): Promise<void> {
  await withHostPg(async (client) => {
    await client.query(`drop table if exists ${DEST_TABLE}`);
    const { rowCount } = await client.query("select 1 from pg_roles where rolname = $1", [WRITE_ROLE_USER]);
    if (rowCount) {
      await client.query(`revoke create on schema public from ${WRITE_ROLE_USER}`).catch(() => {});
      // Also drops the "nia" schema and anything left in it (staging/
      // quarantine tables the role created) — same pattern as
      // write-smoke-staged.ts's cleanup.
      await client.query(`drop owned by ${WRITE_ROLE_USER}`);
      await client.query(`drop role if exists ${WRITE_ROLE_USER}`);
    }
  });
  await withMongo(async (db) => {
    await db.collection(SRC_COLLECTION).drop().catch(() => {});
  });
}

async function getOrgId(): Promise<string> {
  const { data, error } = await supabaseAdmin.from("organizations").select("id").eq("slug", "icecream-co").single();
  if (error || !data) throw new Error(`Could not find seed.sql's demo org: ${error?.message}`);
  return data.id as string;
}

async function seedConnection(
  orgId: string,
  connectorId: "mongodb" | "supabase",
  handle: string,
  displayName: string,
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
    .eq("name", "Destination contract smoke")
    .maybeSingle();
  let projectId = existingProject?.id as string | undefined;
  if (!projectId) {
    const { data, error } = await supabaseAdmin
      .from("projects")
      .insert({ org_id: orgId, name: "Destination contract smoke", created_by: DEMO_USER_ID })
      .select("id")
      .single();
    if (error || !data) throw new Error(`project insert failed: ${error?.message}`);
    projectId = data.id as string;
  }

  const workflowName = "Destination contract smoke - mongo to new postgres table";
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
        manifestId: "mongodb",
        connectionId: sourceConnId,
        position: { x: 0, y: 0 },
        config: { operation: "read", entity: { namespace: "sandbox", name: SRC_COLLECTION } },
      },
      {
        id: "tf",
        type: "transform",
        position: { x: 150, y: 0 },
        config: {
          steps: [
            {
              kind: "computed_field",
              name: "amount_check",
              expression: { kind: "call", fn: "to_number", args: [{ kind: "field", name: "amount_text" }] },
              onFailure: "quarantine",
            },
          ],
        },
      },
      {
        id: "dest",
        type: "destination",
        manifestId: "supabase",
        connectionId: destConnId,
        position: { x: 300, y: 0 },
        config: {
          operation: "insert",
          entity: { namespace: "public", name: DEST_TABLE },
          mapping: {
            version: 1,
            entries: [
              { from: "id", to: "id" },
              { from: "address.city", to: "city" },
              { from: "address.zip", to: "zip" },
              { from: "tags", to: "tags" },
              { from: "amount_text", to: "amount_text" },
            ],
            approvedAt: new Date().toISOString(),
          },
          upsertKeys: ["id"],
          // writeMode deliberately absent -> defaults to "staged", the
          // only mode ensureDestination is wired into (Part 4 scope).
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

async function main(): Promise<void> {
  let failures = 0;
  const track = (ok: boolean) => {
    if (!ok) failures++;
  };

  log("=== SEEDING (not part of the destination-contract proof below) ===");
  await seedMongo();
  await provisionRoleAndTable();
  const orgId = await getOrgId();
  const scope: WorkspaceScope = { orgId };
  const sourceConnId = await seedConnection(
    orgId,
    "mongodb",
    "@mongodb-destcontract-smoke",
    "Destination contract smoke (mongodb)",
    CONTAINER_MONGO,
  );
  const destConnId = await seedConnection(
    orgId,
    "supabase",
    "@supabase-destcontract-smoke",
    "Destination contract smoke (supabase)",
    CONTAINER_PG,
  );
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

  const { workflowId } = await seedWorkflowGraph(orgId, sourceConnId, destConnId);
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

  log("\n=== RUN: mongo (nested doc + array field) -> brand-new postgres table ===");
  const result = await runEtl(job, queueStub([]));
  track(assert("status 'done'", result.status === "done", result));

  const run = await getRunStatus(runId);
  track(assert("workflow_runs.status: succeeded", run.status === "succeeded", run));
  // 3 source rows, 1 quarantined (non-numeric amount_text) -> 2 written.
  track(assert("workflow_runs.rows_processed: 2 (1 of 3 quarantined)", run.rows_processed === 2, run));

  await withHostPg(async (client) => {
    const { rows: cols } = await client.query(
      "select column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = $1 order by column_name",
      [DEST_TABLE],
    );
    const byName = new Map(cols.map((c) => [c.column_name as string, c]));
    track(assert("created table exists with exactly the 5 mapped columns", cols.length === 5, cols));
    track(
      assert(
        "id column: numeric (mongo BSON number -> float -> double precision) and NOT NULL (key)",
        byName.get("id")?.data_type === "double precision" && byName.get("id")?.is_nullable === "NO",
        byName.get("id"),
      ),
    );
    track(assert("city column: text", byName.get("city")?.data_type === "text", byName.get("city")));
    track(assert("zip column: text", byName.get("zip")?.data_type === "text", byName.get("zip")));
    track(assert("amount_text column: text", byName.get("amount_text")?.data_type === "text", byName.get("amount_text")));
    track(
      assert(
        "tags column: jsonb (mongo array collapsed to json, per niaAdapters.ts's mongoToNiaType)",
        byName.get("tags")?.data_type === "jsonb",
        byName.get("tags"),
      ),
    );

    const { rows: destRows } = await client.query(`select id, city, zip, amount_text, tags from ${DEST_TABLE} order by id`);
    track(assert("2 rows written to the destination (row id=2 quarantined, not written)", destRows.length === 2, destRows));
    track(assert("quarantined row (id=2) is absent from the destination", !destRows.some((r) => r.id === 2), destRows));

    const row1 = destRows.find((r) => r.id === 1);
    track(
      assert(
        "row id=1's tags column is valid JSON matching the source array",
        JSON.stringify(row1?.tags) === JSON.stringify(["a", "b"]),
        row1,
      ),
    );
    const row3 = destRows.find((r) => r.id === 3);
    track(
      assert(
        "row id=3's tags column is valid JSON matching the source array",
        JSON.stringify(row3?.tags) === JSON.stringify(["d", "e", "f"]),
        row3,
      ),
    );

    const { rows: quarantined } = await client.query(
      "select run_id, dest_table, function, status, source_row from nia.nia_quarantine where run_id = $1",
      [runId],
    );
    track(assert("exactly 1 quarantined row recorded for this run", quarantined.length === 1, quarantined));
    const q = quarantined[0] as { dest_table: string; function: string; status: string; source_row: Record<string, unknown> } | undefined;
    track(assert("quarantine row: status committed (this run's apply succeeded)", q?.status === "committed", q));
    track(assert("quarantine row: function is to_number", q?.function === "to_number", q));
    track(assert("quarantine row: dest_table matches the destination entity", q?.dest_table === `public.${DEST_TABLE}`, q));
    track(assert("quarantine row: source_row captures the original failing document (id=2)", q?.source_row?.id === 2, q));
  });

  if (!process.env.SKIP_CLEANUP) {
    log("\n=== CLEANUP ===");
    await cleanup();
    log("Dropped the scratch table, write role (and everything it owned), and the mongo scratch collection.");
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
