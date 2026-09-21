/**
 * Live smoke test for the profiler (apps/worker/src/lib/profile/) — Phase
 * 10 Step 4 test 3. NOT mocks: seeds the SAME messy table (same columns,
 * same row shapes) into real sandbox mysql/postgres/mongo, profiles each
 * through the real profileEntity() orchestrator (resolveConnection ->
 * getSchema -> sampleEntity -> computeColumnStats -> computeSignature),
 * and asserts the resulting stats agree across all three connectors
 * except for connector-native declared type spelling.
 *
 * Run with (from apps/worker/):
 *   npx tsx scripts/profile-smoke.ts
 * Same prerequisites/env as dispatch-smoke.ts (supabase start; docker
 * compose up -d --build redis dev-mysql dev-mongo dev-postgres
 * connector-mysql connector-mongodb connector-supabase).
 *
 * Table is intentionally small (6 rows) so every run exercises the
 * "full-table" sample method (see sampleEntity.ts) rather than the
 * keyset-head-tail path — that path's own pagination/dedup logic is
 * already covered indirectly by dispatch/queryBuilder's existing tests
 * and smoke scripts; this script's job is the profiler's stats/signature
 * math end-to-end against real driver-deserialized values, not pagination.
 */
import mysql from "mysql2/promise";
import pg from "pg";
import { MongoClient } from "mongodb";
import { createClient } from "@supabase/supabase-js";
import { profileEntity } from "../src/lib/profile/profileEntity.js";
import type { WorkspaceScope } from "../src/lib/workspaceScope.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY must be set (see this script's header comment).");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DEMO_USER_ID = "00000000-0000-0000-0000-0000000000d1";

// Dialed by THIS script, from the host, for provisioning the messy table.
const HOST_MYSQL = { host: "127.0.0.1", port: 3307, user: "root", password: "devroot", database: "sandbox" };
const HOST_PG = { host: "localhost", port: 5433, database: "sandbox", user: "postgres", password: "devroot" };
const HOST_MONGO_URI = "mongodb://root:devroot@localhost:27018/sandbox?authSource=admin";

// Dialed by the connector SERVICE containers, over the compose network —
// same nia_ro read-only role every other smoke script's connections use;
// its grants (GRANT SELECT ON sandbox.* / default-privileges / "read" on
// db "sandbox") already cover any new table/collection with no extra setup.
const SANDBOX = {
  mysql: { host: "dev-mysql", port: 3306, database: "sandbox", user: "nia_ro", password: "nia_ro_pw" },
  mongodb: { host: "dev-mongo", port: 27017, database: "sandbox", user: "nia_ro", password: "nia_ro_pw" },
  supabase: { host: "dev-postgres", port: 5432, database: "sandbox", user: "nia_ro", password: "nia_ro_pw" },
} as const;
type ConnectorId = keyof typeof SANDBOX;

const TABLE = "profile_smoke_source";
// namespace convention per write-smoke.ts (postgres: "public") and
// write-smoke-mysql-mongo.ts (mysql/mongo: the "sandbox" database name).
const NAMESPACE: Record<ConnectorId, string> = { mysql: "sandbox", mongodb: "sandbox", supabase: "public" };

// The same messy row shapes seeded into all three connectors. Columns are
// declared as plain text (varchar/string) everywhere on purpose — a native
// DATE type would make some drivers hand back JS Date objects instead of
// strings, which would silently change isTextColumn/parseRates behavior
// per-connector and break the "profiles agree" assertion below.
const ROWS: { id: number; name: string; amount: string | null; notes: string | null; signup_date: string | null }[] = [
  { id: 1, name: "Ada Lovelace", amount: "100", notes: "first record", signup_date: "2024-01-15" },
  { id: 2, name: "Grace Hopper", amount: "200.5", notes: "", signup_date: "2024-02-20" },
  { id: 3, name: "Alan Turing", amount: "not-a-number", notes: "N/A", signup_date: "not-a-date" },
  { id: 4, name: "Margaret Hamilton", amount: null, notes: "   ", signup_date: null },
  { id: 5, name: "Katherine Johnson", amount: "300", notes: "n/a", signup_date: "2024-03-01" },
  { id: 6, name: "John von Neumann", amount: "400", notes: "another real note", signup_date: "not-parseable-either" },
];

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

let failures = 0;
function assert(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    log(`  PASS  ${label}`);
  } else {
    failures++;
    log(`  FAIL  ${label} ${detail !== undefined ? JSON.stringify(detail) : ""}`);
  }
}

async function provisionMysql(): Promise<void> {
  const conn = await mysql.createConnection(HOST_MYSQL);
  try {
    await conn.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await conn.query(
      `CREATE TABLE ${TABLE} (id INT PRIMARY KEY, name VARCHAR(128) NOT NULL, amount VARCHAR(32), notes VARCHAR(128), signup_date VARCHAR(32))`,
    );
    for (const r of ROWS) {
      await conn.query(`INSERT INTO ${TABLE} (id, name, amount, notes, signup_date) VALUES (?, ?, ?, ?, ?)`, [
        r.id,
        r.name,
        r.amount,
        r.notes,
        r.signup_date,
      ]);
    }
  } finally {
    await conn.end();
  }
}

async function provisionPostgres(): Promise<void> {
  const client = new pg.Client(HOST_PG);
  await client.connect();
  try {
    await client.query(`drop table if exists ${TABLE}`);
    await client.query(
      `create table ${TABLE} (id integer primary key, name varchar(128) not null, amount varchar(32), notes varchar(128), signup_date varchar(32))`,
    );
    for (const r of ROWS) {
      await client.query(`insert into ${TABLE} (id, name, amount, notes, signup_date) values ($1, $2, $3, $4, $5)`, [
        r.id,
        r.name,
        r.amount,
        r.notes,
        r.signup_date,
      ]);
    }
  } finally {
    await client.end();
  }
}

async function provisionMongo(): Promise<void> {
  const client = new MongoClient(HOST_MONGO_URI);
  await client.connect();
  try {
    const db = client.db("sandbox");
    await db.collection(TABLE).drop().catch(() => undefined);
    await db.collection(TABLE).insertMany(
      ROWS.map((r) => ({ _id: r.id, name: r.name, amount: r.amount, notes: r.notes, signup_date: r.signup_date })),
    );
  } finally {
    await client.close();
  }
}

async function getOrgId(): Promise<string> {
  const { data, error } = await supabase.from("organizations").select("id").eq("slug", "icecream-co").single();
  if (error || !data) throw new Error(`Could not find seed.sql's demo org: ${error?.message}`);
  return data.id as string;
}

async function seedConnection(orgId: string, connectorId: ConnectorId): Promise<string> {
  const { host, port, database, user, password } = SANDBOX[connectorId];

  const { count: installCount } = await supabase
    .from("connector_installs")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("connector_id", connectorId);
  if (!installCount) {
    const { error } = await supabase
      .from("connector_installs")
      .insert({ org_id: orgId, connector_id: connectorId, installed_by_user_id: DEMO_USER_ID });
    if (error) throw new Error(`install ${connectorId} failed: ${error.message}`);
  }

  const handle = `@${connectorId}-profile-smoke`;
  const { data: existing } = await supabase.from("connections").select("id").eq("org_id", orgId).eq("handle", handle).maybeSingle();
  if (existing) {
    const { error } = await supabase.from("connections").update({ config: { host, port, database } }).eq("id", existing.id as string);
    if (error) throw new Error(`connection config update for ${connectorId} failed: ${error.message}`);
    return existing.id as string;
  }

  const { data: vaultRef, error: vaultError } = await supabase.rpc("create_connector_secret", { p_secret: { user, password } });
  if (vaultError || !vaultRef) throw new Error(`vault write for ${connectorId} failed: ${vaultError?.message}`);

  const { data, error } = await supabase
    .from("connections")
    .insert({
      org_id: orgId,
      owner_id: null,
      connector_id: connectorId,
      handle,
      display_name: `Profile smoke (${connectorId})`,
      owner_user_id: DEMO_USER_ID,
      config: { host, port, database },
      vault_secret_ref: vaultRef as string,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`connection insert for ${connectorId} failed: ${error?.message}`);
  return data.id as string;
}

async function main(): Promise<void> {
  log("=== SEEDING (not part of the profiler proof below) ===");
  await provisionMysql();
  await provisionPostgres();
  await provisionMongo();

  const orgId = await getOrgId();
  const scope: WorkspaceScope = { orgId };
  const connectionIds: Record<ConnectorId, string> = {
    mysql: await seedConnection(orgId, "mysql"),
    mongodb: await seedConnection(orgId, "mongodb"),
    supabase: await seedConnection(orgId, "supabase"),
  };
  log(`Seeded connections: ${JSON.stringify(connectionIds)}`);

  log("\n=== ASSERTIONS: profileEntity() against real infra ===");

  for (const connectorId of ["mysql", "supabase", "mongodb"] as const) {
    const profile = await profileEntity({
      kind: "profile_run",
      scope,
      connectionId: connectionIds[connectorId],
      entity: { namespace: NAMESPACE[connectorId], name: TABLE },
      triggeredByUserId: DEMO_USER_ID,
    });

    assert(`${connectorId}: sampleSize is 6`, profile.sampleSize === 6, profile.sampleSize);
    assert(`${connectorId}: sampleMethod is full-table (6 rows < page size)`, profile.sampleMethod === "full-table", profile.sampleMethod);
    assert(`${connectorId}: 5 columns profiled`, profile.columns.length === 5, profile.columns.map((c) => c.name));

    const amount = profile.columns.find((c) => c.name === "amount");
    assert(`${connectorId}: amount.nullCount is 1`, amount?.nullCount === 1, amount);
    assert(`${connectorId}: amount.isTextColumn`, amount?.isTextColumn === true, amount);
    const toNumber = amount?.parseRates?.to_number;
    assert(`${connectorId}: amount to_number attempted=5 passed=4`, toNumber?.attempted === 5 && toNumber?.passed === 4, toNumber);
    assert(`${connectorId}: amount to_number failing example is "not-a-number"`, toNumber?.failingExamples.includes("not-a-number") === true, toNumber);

    const notes = profile.columns.find((c) => c.name === "notes");
    assert(`${connectorId}: notes.emptyStringCount is 1`, notes?.emptyStringCount === 1, notes);
    assert(`${connectorId}: notes.whitespaceOnlyCount is 1`, notes?.whitespaceOnlyCount === 1, notes);
    assert(`${connectorId}: notes.missingTokenCount is 2 ("N/A", "n/a")`, notes?.missingTokenCount === 2, notes);

    const signupDate = profile.columns.find((c) => c.name === "signup_date");
    assert(`${connectorId}: signup_date.nullCount is 1`, signupDate?.nullCount === 1, signupDate);
    const isoDate = signupDate?.parseRates?.parse_date_iso;
    assert(`${connectorId}: signup_date parse_date_iso attempted=5 passed=3`, isoDate?.attempted === 5 && isoDate?.passed === 3, isoDate);

    assert(`${connectorId}: profileHash is non-empty`, typeof profile.profileHash === "string" && profile.profileHash.length > 0, profile.profileHash);
    assert(`${connectorId}: signature has 5 entries`, profile.signature.length === 5, profile.signature.length);
  }

  log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
