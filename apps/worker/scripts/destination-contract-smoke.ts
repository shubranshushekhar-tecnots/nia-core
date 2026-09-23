/**
 * Schema-layer Part 4/5 — live smoke test: mongo nested documents into a
 * brand-new postgres destination table (ensureDestination's CREATE path),
 * proving: (1) the created columns' native types, including a mongo array
 * field collapsed to a single JSONB column, (2) that array's values
 * round-trip as valid JSON, (3) a row whose `amount_text` fails an
 * EXPLICIT fallible transform (to_number, onFailure="quarantine") is
 * quarantined — never reaches the destination, and (4) Part 5's IMPLICIT
 * run-time conformance cast independently quarantines a row whose `qty`
 * column doesn't match its contract type (double precision, correctly
 * derived from the pipeline's post-transform output schema — Part 5
 * follow-up's compileTransformOutputSchema) because that one document has
 * a non-numeric string underneath a field mongo's own sampling-based
 * introspection otherwise infers as numeric — proving the cast-to-
 * contract-type step fires with no explicit onFailure config on that
 * column at all. The rest of the run still succeeds in both cases.
 *
 * NOT a substitute for destinationContract.test.ts/ensureDestination's own
 * unit coverage of buildDestinationContract/compareContractToExisting in
 * isolation — this script proves the real wiring: a real mongo source
 * (through connector-mongodb's /introspect + flatten.ts), runEtl.ts's
 * Part 4 reordered staged-mode flow (ensureDestination runs before
 * preflight/staging), a real connector-supabase /create-entity CREATE
 * TABLE, the existing onFailure="quarantine" residual pipeline (composed
 * here, not new machinery), and Part 5's applyConformance (packages/
 * schemas/src/ops/conformance.ts), wired unconditionally into every run by
 * runEtl.ts's buildRuntimeContract call.
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
      // Schema layer Part 5 follow-up: the transform graph below overwrites
      // qty's runtime value from qty_override_text via a bare field-
      // reference computed_field step, so the destination contract's type
      // for "qty" is now built from qty_override_text's OWN inferred type
      // (compileTransformOutputSchema, run against the post-transform
      // output schema), not qty's raw pre-transform type. connector-
      // mongodb's introspection infers a field's type from the first
      // non-null sampled value (services/connector-mongodb/src/column-
      // types.ts's inferColumnType) — doc id=1 is inserted (and therefore
      // sampled) first, and its qty_override_text is a genuine BSON
      // number, so qty_override_text (and therefore qty, post-transform)
      // is correctly inferred/typed "number"/"double precision".
      { id: 1, address: { city: "Springfield", zip: "11111" }, tags: ["a", "b"], amount_text: "12.5", qty: 5, qty_override_text: 5 },
      // amount_text is non-numeric here -> to_number(amount_text) fails ->
      // quarantined by the EXPLICIT computed_field step, never reaches the
      // destination (nor the qty-overwrite step after it).
      { id: 2, address: { city: "Shelbyville", zip: "22222" }, tags: ["c"], amount_text: "N/A", qty: 3, qty_override_text: 3 },
      // qty_override_text is a STRING on this doc even though the field's
      // inferred type (above, from doc id=1) is numeric — a genuine per-
      // row type-inference edge case (mongo has no per-field schema, and
      // introspection only samples/infers from the first non-null value)
      // that the correctly-typed contract can't foresee. After the qty-
      // overwrite step, qty holds this non-numeric string, which fails
      // Part 5's implicit conformance cast (to_number, contract type
      // double precision) -> quarantined by conformance, never reaches
      // the destination. This is what Part 5's implicit cast exists to
      // catch — independent of, and not a workaround for, the Part 5
      // follow-up contract-derivation fix above.
      { id: 3, address: { city: "Ogdenville", zip: "33333" }, tags: ["d", "e", "f"], amount_text: "7", qty: 7, qty_override_text: "not-a-number" },
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
            // Schema layer, Part 5 follow-up proof: a bare field-reference
            // expression (no call, so nothing fallible about THIS step —
            // no onFailure needed) overwrites qty's runtime value with
            // qty_override_text's. The contract now types qty from
            // qty_override_text's OWN inferred type (compileTransform
            // OutputSchema, run through every step's outputSchema in
            // order) — "number"/"double precision", since doc id=1's
            // qty_override_text (sampled first by connector-mongodb's
            // introspection) is a genuine BSON number. Only doc id=3's
            // qty_override_text is a string — a genuine per-row type-
            // inference edge case the contract can't foresee — caught
            // downstream by Part 5's implicit conformance cast, not by
            // the contract itself.
            {
              kind: "computed_field",
              name: "qty",
              expression: { kind: "field", name: "qty_override_text" },
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
              { from: "qty", to: "qty" },
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
  // 3 source rows: id=2 quarantined by the explicit computed_field step
  // (amount_text), id=3 quarantined by Part 5's implicit conformance cast
  // (qty) -> 1 written.
  track(assert("workflow_runs.rows_processed: 1 (2 of 3 quarantined)", run.rows_processed === 1, run));

  await withHostPg(async (client) => {
    const { rows: cols } = await client.query(
      "select column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = $1 order by column_name",
      [DEST_TABLE],
    );
    const byName = new Map(cols.map((c) => [c.column_name as string, c]));
    track(assert("created table exists with exactly the 6 mapped columns", cols.length === 6, cols));
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
    track(
      assert(
        "qty column: numeric (contract built from the post-transform output schema — qty's type equals qty_override_text's own inferred type, number)",
        byName.get("qty")?.data_type === "double precision",
        byName.get("qty"),
      ),
    );

    const { rows: destRows } = await client.query(`select id, city, zip, amount_text, tags, qty from ${DEST_TABLE} order by id`);
    track(
      assert(
        "1 row written to the destination (id=2 explicit-quarantine, id=3 conformance-quarantine, neither written)",
        destRows.length === 1,
        destRows,
      ),
    );
    track(assert("explicit-quarantine row (id=2) is absent from the destination", !destRows.some((r) => r.id === 2), destRows));
    track(assert("conformance-quarantine row (id=3) is absent from the destination", !destRows.some((r) => r.id === 3), destRows));

    const row1 = destRows.find((r) => r.id === 1);
    track(
      assert(
        "row id=1's tags column is valid JSON matching the source array",
        JSON.stringify(row1?.tags) === JSON.stringify(["a", "b"]),
        row1,
      ),
    );
    track(assert("row id=1's qty column: 5 (qty_override_text was numeric, conformance cast a no-op pass)", row1?.qty === 5, row1));

    const { rows: quarantined } = await client.query(
      "select run_id, dest_table, step_id, function, status, source_row from nia.nia_quarantine where run_id = $1 order by (source_row->>'id')::int",
      [runId],
    );
    track(assert("exactly 2 quarantined rows recorded for this run", quarantined.length === 2, quarantined));
    type QRow = { dest_table: string; step_id: string; function: string; status: string; source_row: Record<string, unknown> };
    const explicitQ = quarantined.find((q) => (q as QRow).source_row?.id === 2) as QRow | undefined;
    const conformanceQ = quarantined.find((q) => (q as QRow).source_row?.id === 3) as QRow | undefined;

    track(assert("explicit-quarantine row: status committed", explicitQ?.status === "committed", explicitQ));
    track(assert("explicit-quarantine row: function is to_number", explicitQ?.function === "to_number", explicitQ));
    track(assert("explicit-quarantine row: step_id names the computed_field step", explicitQ?.step_id === `computed_field "amount_check"`, explicitQ));
    track(assert("explicit-quarantine row: dest_table matches the destination entity", explicitQ?.dest_table === `public.${DEST_TABLE}`, explicitQ));

    track(
      assert(
        "conformance-quarantine row: status committed (Part 5's implicit cast step, no explicit onFailure on qty)",
        conformanceQ?.status === "committed",
        conformanceQ,
      ),
    );
    track(
      assert(
        "conformance-quarantine row: function is to_number (contract type double precision, from qty_override_text's inferred type)",
        conformanceQ?.function === "to_number",
        conformanceQ,
      ),
    );
    track(
      assert(
        `conformance-quarantine row: step_id names the conformance step, not any explicit onFailure config`,
        conformanceQ?.step_id === `conformance "qty"`,
        conformanceQ,
      ),
    );
    track(
      assert("conformance-quarantine row: dest_table matches the destination entity", conformanceQ?.dest_table === `public.${DEST_TABLE}`, conformanceQ),
    );
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
