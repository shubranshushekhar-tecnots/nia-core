/**
 * Phase 6 Block 5, Part 3g — live smoke test for connector-mysql and
 * connector-mongodb's new POST /write (mirrors write-smoke.ts's structure
 * and rationale, condensed to one script covering both new dialects: real
 * Postgres for the grant lifecycle, real connector-mysql/connector-mongodb
 * containers for the HTTP hop + HMAC/grant re-check, and the real
 * docker-compose dev-mysql/dev-mongo sandboxes as write targets. 3 rows
 * each, proves the wire — NOT a substitute for writeSql.test.ts/
 * writeOps.test.ts's unit coverage of the statement/op shaping itself.
 *
 * Run with (from apps/worker/):
 *   npx tsx scripts/write-smoke-mysql-mongo.ts
 *
 * Prerequisites (not started by this script):
 *   - `supabase start`
 *   - `docker compose up -d --build redis dev-mysql dev-mongo connector-mysql connector-mongodb`
 *   - apps/web/.env.local (or supabase status) for SUPABASE_ANON_KEY
 */
import mysql from "mysql2/promise";
import { MongoClient } from "mongodb";
import { createClient } from "@supabase/supabase-js";
import { dispatchWrite } from "../src/lib/writeDispatch.js";
import type { WorkspaceScope } from "../src/lib/workspaceScope.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY must be set.");
if (!ANON_KEY) throw new Error("SUPABASE_ANON_KEY must be set (e.g. copy from apps/web/.env.local).");

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DEMO_USER_ID = "00000000-0000-0000-0000-0000000000d1";
const DEMO_EMAIL = "demo@nia.dev";
const DEMO_PASSWORD = "password";

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

function assert(label: string, cond: boolean, detail?: unknown): boolean {
  log(`  ${cond ? "PASS" : "FAIL"}  ${label} ${!cond && detail !== undefined ? JSON.stringify(detail) : ""}`);
  return cond;
}

async function getOrgId(): Promise<string> {
  const { data, error } = await supabaseAdmin.from("organizations").select("id").eq("slug", "icecream-co").single();
  if (error || !data) throw new Error(`Could not find seed.sql's demo org: ${error?.message}`);
  return data.id as string;
}

async function signInDemo() {
  const supabaseUser = createClient(SUPABASE_URL, ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await supabaseUser.auth.signInWithPassword({ email: DEMO_EMAIL, password: DEMO_PASSWORD });
  if (error) throw new Error(`sign-in as demo user failed: ${error.message}`);
  return supabaseUser;
}

async function seedConnection(
  orgId: string,
  connectorId: string,
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
  if (existing) return existing.id as string;

  const { data: vaultRef, error: vaultError } = await supabaseAdmin.rpc("create_connector_secret", {
    p_secret: { user: "nia_ro", password: "nia_ro_pw" },
  });
  if (vaultError || !vaultRef) throw new Error(`vault write for read cred failed: ${vaultError?.message}`);

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
  if (error || !data) throw new Error(`connection insert failed: ${error?.message}`);
  return data.id as string;
}

async function mintAndConfirmGrant(
  supabaseUser: ReturnType<typeof createClient>,
  connectionId: string,
  schema: string,
  writeUser: string,
  writePassword: string,
): Promise<string> {
  const { data: writeVaultRef, error: vaultError } = await supabaseAdmin.rpc("create_connector_secret", {
    p_secret: { user: writeUser, password: writePassword },
  });
  if (vaultError || !writeVaultRef) throw new Error(`vault write for write cred failed: ${vaultError?.message}`);

  const { data: grantRow, error: grantError } = await supabaseUser.rpc("create_write_grant", {
    p_connection_id: connectionId,
    p_scope: { schemas: [schema] },
  });
  if (grantError || !grantRow) throw new Error(`create_write_grant failed: ${grantError?.message}`);
  const grantId = (grantRow as { id: string }).id;

  const { error: confirmError } = await supabaseUser.rpc("confirm_write_grant", {
    p_grant_id: grantId,
    p_write_credential_vault_ref: writeVaultRef as string,
  });
  if (confirmError) throw new Error(`confirm_write_grant failed: ${confirmError.message}`);
  return grantId;
}

async function smokeMysql(orgId: string, supabaseUser: ReturnType<typeof createClient>, track: (ok: boolean) => void): Promise<void> {
  log("\n=== connector-mysql /write smoke ===");
  const HOST_MYSQL = { host: "127.0.0.1", port: 3307, user: "root", password: "devroot", database: "sandbox" };
  const CONTAINER_MYSQL = { host: "dev-mysql", port: 3306, database: "sandbox" };
  const SCRATCH_TABLE = "write_smoke_scratch_mysql";
  const WRITE_USER = "nia_write_smoke_mysql";
  const WRITE_PASSWORD = "nia_write_smoke_mysql_pw";

  const admin = await mysql.createConnection(HOST_MYSQL);
  try {
    await admin.query(`DROP TABLE IF EXISTS ${SCRATCH_TABLE}`);
    await admin.query(`CREATE TABLE ${SCRATCH_TABLE} (id INT PRIMARY KEY, note VARCHAR(255) NOT NULL)`);
    await admin.query(`DROP USER IF EXISTS '${WRITE_USER}'@'%'`);
    await admin.query(`CREATE USER '${WRITE_USER}'@'%' IDENTIFIED BY '${WRITE_PASSWORD}'`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE ON sandbox.${SCRATCH_TABLE} TO '${WRITE_USER}'@'%'`);
    await admin.query("FLUSH PRIVILEGES");

    const connectionId = await seedConnection(orgId, "mysql", "@mysql-write-smoke", "Write smoke (mysql)", CONTAINER_MYSQL);
    log(`Seeded connection: ${connectionId}`);
    const grantId = await mintAndConfirmGrant(supabaseUser, connectionId, "sandbox", WRITE_USER, WRITE_PASSWORD);
    log(`Confirmed write grant: ${grantId}`);

    const scope: WorkspaceScope = { orgId };
    const result = await dispatchWrite(
      connectionId,
      {
        entity: { namespace: "sandbox", name: SCRATCH_TABLE },
        columns: ["id", "note"],
        rows: [
          [1, "alpha"],
          [2, "beta"],
          [3, "gamma"],
        ],
        upsertKeys: ["id"],
      },
      scope,
      DEMO_USER_ID,
    );
    track(assert("dispatchWrite ok", result.ok, result.ok ? undefined : result.error));
    if (result.ok) track(assert("dispatchWrite reports written: 3", result.value.written === 3, result.value));

    const [rows] = await admin.query(`SELECT id, note FROM ${SCRATCH_TABLE} ORDER BY id`);
    track(assert("3 rows landed in dev-mysql", (rows as unknown[]).length === 3, rows));

    // upsert re-check
    const result2 = await dispatchWrite(
      connectionId,
      {
        entity: { namespace: "sandbox", name: SCRATCH_TABLE },
        columns: ["id", "note"],
        rows: [[1, "alpha-updated"]],
        upsertKeys: ["id"],
      },
      scope,
      DEMO_USER_ID,
    );
    track(assert("upsert dispatchWrite ok", result2.ok, result2.ok ? undefined : result2.error));
    const [rows2] = await admin.query(`SELECT note FROM ${SCRATCH_TABLE} WHERE id = 1`);
    track(assert("id=1 note was updated", (rows2 as Array<{ note: string }>)[0]?.note === "alpha-updated", rows2));

    await admin.query(`DROP TABLE IF EXISTS ${SCRATCH_TABLE}`);
    await admin.query(`DROP USER IF EXISTS '${WRITE_USER}'@'%'`);
  } finally {
    await admin.end();
  }
}

async function smokeMongo(orgId: string, supabaseUser: ReturnType<typeof createClient>, track: (ok: boolean) => void): Promise<void> {
  log("\n=== connector-mongodb /write smoke ===");
  const HOST_MONGO_URI = "mongodb://root:devroot@localhost:27018/sandbox?authSource=admin";
  const CONTAINER_MONGO = { host: "dev-mongo", port: 27017, database: "sandbox" };
  const SCRATCH_COLLECTION = "write_smoke_scratch_mongo";
  const WRITE_USER = "nia_write_smoke_mongo";
  const WRITE_PASSWORD = "nia_write_smoke_mongo_pw";

  const adminClient = new MongoClient(HOST_MONGO_URI);
  await adminClient.connect();
  try {
    const db = adminClient.db("sandbox");
    await db.collection(SCRATCH_COLLECTION).drop().catch(() => {});
    try {
      await db.command({ dropUser: WRITE_USER });
    } catch {
      // may not exist yet
    }
    await db.command({
      createUser: WRITE_USER,
      pwd: WRITE_PASSWORD,
      roles: [{ role: "readWrite", db: "sandbox" }],
    });

    const connectionId = await seedConnection(orgId, "mongodb", "@mongodb-write-smoke", "Write smoke (mongodb)", CONTAINER_MONGO);
    log(`Seeded connection: ${connectionId}`);
    const grantId = await mintAndConfirmGrant(supabaseUser, connectionId, "sandbox", WRITE_USER, WRITE_PASSWORD);
    log(`Confirmed write grant: ${grantId}`);

    const scope: WorkspaceScope = { orgId };
    const result = await dispatchWrite(
      connectionId,
      {
        entity: { namespace: "sandbox", name: SCRATCH_COLLECTION },
        columns: ["id", "note"],
        rows: [
          [1, "alpha"],
          [2, "beta"],
          [3, "gamma"],
        ],
        upsertKeys: ["id"],
      },
      scope,
      DEMO_USER_ID,
    );
    track(assert("dispatchWrite ok", result.ok, result.ok ? undefined : result.error));
    if (result.ok) track(assert("dispatchWrite reports written: 3", result.value.written === 3, result.value));

    const docs = await db.collection(SCRATCH_COLLECTION).find({}).sort({ id: 1 }).toArray();
    track(assert("3 docs landed in dev-mongo", docs.length === 3, docs));

    const result2 = await dispatchWrite(
      connectionId,
      {
        entity: { namespace: "sandbox", name: SCRATCH_COLLECTION },
        columns: ["id", "note"],
        rows: [[1, "alpha-updated"]],
        upsertKeys: ["id"],
      },
      scope,
      DEMO_USER_ID,
    );
    track(assert("upsert dispatchWrite ok", result2.ok, result2.ok ? undefined : result2.error));
    const doc1 = await db.collection(SCRATCH_COLLECTION).findOne({ id: 1 });
    track(assert("id=1 note was updated", doc1?.note === "alpha-updated", doc1));

    await db.collection(SCRATCH_COLLECTION).drop().catch(() => {});
    await db.command({ dropUser: WRITE_USER }).catch(() => {});
  } finally {
    await adminClient.close();
  }
}

async function main(): Promise<void> {
  let failures = 0;
  const track = (ok: boolean) => {
    if (!ok) failures++;
  };

  const orgId = await getOrgId();
  const supabaseUser = await signInDemo();

  await smokeMysql(orgId, supabaseUser, track);
  await smokeMongo(orgId, supabaseUser, track);

  log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
