/**
 * Phase 8b-2a — shared DB-execution conformance harness.
 *
 * `packages/schemas`'s `pushdown.ts` is documented "pure, no I/O" and has
 * zero DB-driver dependencies (only `zod`) — so this harness lives here in
 * `apps/worker` instead, which already depends on `mysql2`/`pg`/`mongodb`
 * and already hosts the 3 existing smoke scripts this generalizes the
 * connection/seeding boilerplate from (`dispatch-smoke.ts`,
 * `aggregate-smoke.ts`, `write-smoke-mysql-mongo.ts`).
 *
 * Proves pushdown emission is correct (not just shaped-right) by running
 * it through the exact production path `runEtl.ts` uses:
 *   compilePushdown (@nia/schemas, pure)
 *     -> buildEtlReadQuery (apps/worker/src/lib/etl/queryBuilder.ts)
 *     -> dispatch (apps/worker/src/lib/dispatch.ts)
 * against a real scratch table/collection seeded with caller-supplied
 * rows, using a real `connections` row pointed at the docker-compose
 * sandbox DB (same seeding pattern as the 3 existing smoke scripts).
 *
 * Column DDL for SQL scratch tables is inferred from each seed row's JS
 * value types (number -> DOUBLE/double precision, string -> VARCHAR(255)/
 * text, boolean -> BOOLEAN, null-only column -> nullable TEXT fallback). A
 * harness-owned `id` key column (mysql/postgres) is always added and
 * auto-numbered 1..N so `buildEtlReadQuery`'s non-aggregate SQL branch
 * (which throws without a `keyColumn`) is always satisfiable without every
 * fixture/case needing to declare its own key — none of the fixture/
 * agreement-case seed data uses a field literally named `id`, so this
 * can't collide. Mongo doesn't need this: `_id` is native, and seed rows
 * get `_id: 1..N` auto-assigned the same way if they don't declare one.
 *
 * Read access: the docker-compose init scripts (`docker/dev-*-init.*`)
 * already grant `nia_ro` broad read access to the whole `sandbox`
 * database/schema (mysql: `GRANT SELECT ON sandbox.*`; postgres:
 * `alter default privileges ... grant select on tables`; mongo: the
 * built-in `read` role on the db) — so a table/collection created here
 * *after* those grants ran is automatically readable by the
 * `nia_ro`-credentialed connection this harness seeds, with no extra
 * per-table GRANT needed.
 *
 * Prerequisites (not started by this file):
 *   - `supabase start`
 *   - `docker compose up -d redis dev-mysql dev-mongo dev-postgres
 *     connector-mysql connector-mongodb connector-supabase`
 *   - apps/worker/.env for SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { MongoClient } from "mongodb";
import { createClient } from "@supabase/supabase-js";
import type { DialectQuery, FailurePreCheck, SourceDialect, SqlGroupKeyCursor, TransformConfig } from "@nia/schemas";
import { compilePushdown } from "@nia/schemas";
import { dispatch } from "../../src/lib/dispatch.js";
import { buildEtlReadQuery, buildFailurePreCheckQuery, MAX_CHUNK_ROWS } from "../../src/lib/etl/queryBuilder.js";
import type { WorkspaceScope } from "../../src/lib/workspaceScope.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY must be set (see dispatch-smoke.ts's header comment for prerequisites).");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DEMO_USER_ID = "00000000-0000-0000-0000-0000000000d1";

// Dialed by the connector SERVICE containers (compose service names +
// container-internal ports) — never the host-remapped ports below, which
// only exist so this script/a human can reach the sandbox DBs directly.
// See dispatch-smoke.ts's header comment for the full duality explanation.
const CONTAINER_SANDBOX: Record<SourceDialect, { connectorId: string; host: string; port: number; database: string }> = {
  mysql: { connectorId: "mysql", host: "dev-mysql", port: 3306, database: "sandbox" },
  postgres: { connectorId: "supabase", host: "dev-postgres", port: 5432, database: "sandbox" },
  mongo: { connectorId: "mongodb", host: "dev-mongo", port: 27017, database: "sandbox" },
};

const MYSQL_CONTAINER = "nia-core-dev-mysql-1";
const HOST_PG = { host: "localhost", port: 5433, database: "sandbox", user: "postgres", password: "devroot" };
const HOST_MONGO_URI = "mongodb://root:devroot@localhost:27018/sandbox?authSource=admin";

let orgIdCache: string | null = null;
async function getOrgId(): Promise<string> {
  if (orgIdCache) return orgIdCache;
  const { data, error } = await supabase.from("organizations").select("id").eq("slug", "icecream-co").single();
  if (error || !data) throw new Error(`Could not find seed.sql's demo org: ${error?.message}`);
  orgIdCache = data.id as string;
  return orgIdCache;
}

/**
 * One shared nia_ro connection per dialect, seeded once and reused across
 * every provision*Fixture call in a process (mirrors dispatch-smoke.ts's
 * per-connector-id seedConnection, upsert-by-handle so reruns are
 * idempotent) — the scratch table/collection varies per fixture, the
 * connection pointed at the sandbox DB does not.
 */
const connectionIdCache = new Map<SourceDialect, string>();

async function seedConnection(dialect: SourceDialect): Promise<string> {
  const cached = connectionIdCache.get(dialect);
  if (cached) return cached;

  const orgId = await getOrgId();
  const { connectorId, host, port, database } = CONTAINER_SANDBOX[dialect];
  const handle = `@${connectorId}-db-harness`;

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

  const { data: existing } = await supabase
    .from("connections")
    .select("id")
    .eq("org_id", orgId)
    .eq("handle", handle)
    .maybeSingle();
  if (existing) {
    connectionIdCache.set(dialect, existing.id as string);
    return existing.id as string;
  }

  const { data: vaultRef, error: vaultError } = await supabase.rpc("create_connector_secret", {
    p_secret: { user: "nia_ro", password: "nia_ro_pw" },
  });
  if (vaultError || !vaultRef) throw new Error(`vault write for ${connectorId} failed: ${vaultError?.message}`);

  const { data, error } = await supabase
    .from("connections")
    .insert({
      org_id: orgId,
      owner_id: null,
      connector_id: connectorId,
      handle,
      display_name: `DB harness (${connectorId})`,
      owner_user_id: DEMO_USER_ID,
      config: { host, port, database },
      vault_secret_ref: vaultRef as string,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`connection insert for ${connectorId} failed: ${error?.message}`);
  connectionIdCache.set(dialect, data.id as string);
  return data.id as string;
}

export type ScratchTable = { namespace: string; name: string; keyColumn: string };

export type ProvisionedFixture = {
  connectionId: string;
  scope: WorkspaceScope;
  table: ScratchTable;
  cleanup(): Promise<void>;
};

function scratchName(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

// ---- column type inference (mysql/postgres scratch tables) ----------------

function inferColumns(seedRows: Record<string, unknown>[]): string[] {
  const cols = new Set<string>();
  for (const row of seedRows) for (const k of Object.keys(row)) cols.add(k);
  return [...cols];
}

/**
 * Item 1 (pre-batch-5 hardening) — date/timestamp column support. Mirrors
 * sqlShared.ts's own ISO_DATE_LITERAL_RE shape family exactly (date-only /
 * datetime-no-tz / datetime-with-Z), so a seed column's inferred SQL type
 * genuinely matches what castAmbiguousLiteral's date branch targets, rather
 * than reinventing a second, possibly-divergent notion of "date-shaped".
 *
 * OPT-IN ONLY, via the `dateColumns` set a caller explicitly passes to
 * provision*Fixture — never auto-detected from a column's value shape.
 * First cut of this DID auto-detect (any column whose non-null values were
 * uniformly date-shaped got promoted), and that broke 2 pre-existing
 * agreement cases live: the `to_date(x)` cases deliberately seed `x` as a
 * date-SHAPED STRING in what must stay a text/string column, because the
 * whole point of those cases is proving to_date() parses a string — with
 * auto-detection, `x` silently became a real DATE/DATETIME column
 * (mysql/postgres) and a real BSON Date (mongo), which is a completely
 * different input type to that same function and changed its output
 * shape/behavior, producing 2 new DIVERGEs having nothing to do with this
 * change's actual intent. Any shape-sniffing heuristic here has that same
 * blast radius on every OTHER existing/future case using a date-shaped
 * string for an unrelated reason — opt-in via explicit column name is the
 * only version of this that can't silently reclassify a case its author
 * never asked to change.
 */
type DateShape = "date" | "datetime" | "datetime_tz";
function dateShape(v: string): DateShape | null {
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v)) return "date";
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(v)) return "datetime_tz";
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}$/.test(v)) return "datetime";
  return null;
}

/**
 * Batch 5 harness fix — a documented JS `Date` parsing pitfall: a date-ONLY
 * ISO string ("2024-01-15") is spec'd to parse as UTC midnight, but a
 * date-TIME string with no zone suffix ("2024-03-07T15:42:33", this file's
 * "datetime" DateShape) is spec'd to parse as LOCAL time in the running
 * process — silently pulling the harness process's own OS timezone into
 * "UTC-pinned" test data. Every prior `dateColumns` case happened to use
 * only date-only shapes, so this was never exercised until batch 5 added
 * datetime-with-time-of-day cases and was caught live on a non-UTC dev
 * machine (IST, UTC+5:30) as an exact -5:30 offset in mongo's seeded Date
 * values and in ops-agreement.ts's residual-arm row echo (both of which
 * call `new Date(dateShapedString)` on this exact shape) — NOT in mysql/
 * postgres, which never round-trip the seed value through a JS `Date`.
 * Callers needing a real Date/instant from a `dateColumns`-shaped string
 * MUST go through this helper instead of `new Date(v)` directly.
 */
export function parseDateShapedString(v: string): Date {
  const shape = dateShape(v);
  if (shape === "datetime") return new Date(`${v.replace(" ", "T")}Z`);
  return new Date(v);
}

function inferSqlType(
  col: string,
  seedRows: Record<string, unknown>[],
  flavor: "mysql" | "postgres",
  dateColumns: ReadonlySet<string>,
  decimalColumns: ReadonlySet<string> = new Set(),
): string {
  let sawNumber = false;
  let sawString = false;
  let sawBoolean = false;
  let sawNonNull = false;
  let sawNonDateString = false;
  const dateShapes = new Set<DateShape>();
  const treatAsDate = dateColumns.has(col);
  for (const row of seedRows) {
    const v = row[col];
    if (v === null || v === undefined) continue;
    sawNonNull = true;
    if (typeof v === "number") sawNumber = true;
    else if (typeof v === "boolean") sawBoolean = true;
    else {
      sawString = true;
      const shape = treatAsDate && typeof v === "string" ? dateShape(v) : null;
      if (shape) dateShapes.add(shape);
      else sawNonDateString = true;
    }
  }
  if (!sawNonNull) return flavor === "mysql" ? "TEXT" : "text";
  if (sawBoolean && !sawNumber && !sawString) return flavor === "mysql" ? "BOOLEAN" : "boolean";
  if (sawNumber && !sawString && !sawBoolean) {
    // Opt-in only (mirrors the `dateColumns` pattern above): a plain
    // numeric seed value is ambiguous between "integer", "double", and
    // "decimal" — DOUBLE is the safe default. A caller that needs to prove
    // a driver-level DECIMAL-vs-number rendering distinction (mysql2
    // returns DECIMAL columns as JS strings, e.g. "10.00", but DOUBLE
    // columns as JS numbers) must opt a column into `decimalColumns`
    // explicitly.
    if (decimalColumns.has(col)) return flavor === "mysql" ? "DECIMAL(10,2)" : "numeric(10,2)";
    return flavor === "mysql" ? "DOUBLE" : "double precision";
  }
  if (treatAsDate && sawString && !sawNumber && !sawBoolean && !sawNonDateString && dateShapes.size === 1) {
    const shape = [...dateShapes][0]!;
    if (flavor === "mysql") return shape === "date" ? "DATE" : "DATETIME";
    return shape === "date" ? "date" : shape === "datetime_tz" ? "timestamptz" : "timestamp";
  }
  return flavor === "mysql" ? "VARCHAR(255)" : "text";
}

function sqlLiteral(v: unknown, flavor?: "mysql" | "postgres", treatAsDate?: boolean): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (flavor === "mysql" && treatAsDate && typeof v === "string" && dateShape(v)) {
    // Confirmed live: mysql rejects the ISO 'T'/'Z' shape directly for
    // DATE/DATETIME columns ("Incorrect datetime value") — postgres
    // accepts it as-is for date/timestamp/timestamptz, no transform
    // needed there. Only strip for a caller-declared date column (see
    // the opt-in rationale above) and only for values that are actually
    // date-shaped (a plain string containing a literal capital T or Z in
    // a non-date column is untouched).
    return `'${v.replace("T", " ").replace(/Z$/, "")}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

// ---- mysql ------------------------------------------------------------------

/**
 * Phase 8b-2, batch 3: `--default-character-set=utf8mb4` is REQUIRED here,
 * not stylistic. Verified live: the mysql CLI's `character_set_client`
 * defaults to `latin1` even though this sandbox's database/collation are
 * `utf8mb4`/`utf8mb4_0900_ai_ci` — without this flag, any multi-byte UTF-8
 * seed data (accented Latin, CJK, emoji) sent through `docker exec ...
 * mysql -e sql` gets silently double-encoded/corrupted on INSERT (confirmed
 * via a HEX() round-trip showing mojibake). Batch 3 mandates such seed data
 * by default, so this bug would otherwise poison every text-fn agreement
 * case that includes it.
 */
function mysqlExec(sql: string): void {
  execFileSync("docker", [
    "exec",
    MYSQL_CONTAINER,
    "mysql",
    "--default-character-set=utf8mb4",
    "-uroot",
    "-pdevroot",
    "sandbox",
    "-e",
    sql,
  ]);
}

export async function provisionMysqlFixture(
  seedRows: Record<string, unknown>[],
  dateColumns: readonly string[] = [],
  decimalColumns: readonly string[] = [],
): Promise<ProvisionedFixture> {
  const name = scratchName("harness_mysql");
  const cols = inferColumns(seedRows);
  const dateCols = new Set(dateColumns);
  const decimalCols = new Set(decimalColumns);
  const colDefs = cols.map((c) => `\`${c}\` ${inferSqlType(c, seedRows, "mysql", dateCols, decimalCols)}`).join(", ");
  mysqlExec(`DROP TABLE IF EXISTS ${name};`);
  mysqlExec(`CREATE TABLE ${name} (id INT PRIMARY KEY${colDefs ? `, ${colDefs}` : ""});`);
  if (seedRows.length > 0) {
    const values = seedRows
      .map((row, i) => `(${i + 1}, ${cols.map((c) => sqlLiteral(row[c], "mysql", dateCols.has(c))).join(", ")})`)
      .join(", ");
    const colList = cols.map((c) => `\`${c}\``).join(", ");
    mysqlExec(`INSERT INTO ${name} (id${colList ? `, ${colList}` : ""}) VALUES ${values};`);
  }

  const connectionId = await seedConnection("mysql");
  return {
    connectionId,
    scope: { orgId: await getOrgId() },
    table: { namespace: "sandbox", name, keyColumn: "id" },
    async cleanup() {
      mysqlExec(`DROP TABLE IF EXISTS ${name};`);
    },
  };
}

// ---- postgres ---------------------------------------------------------------

export async function provisionPostgresFixture(
  seedRows: Record<string, unknown>[],
  dateColumns: readonly string[] = [],
  decimalColumns: readonly string[] = [],
): Promise<ProvisionedFixture> {
  const name = scratchName("harness_pg");
  const cols = inferColumns(seedRows);
  const dateCols = new Set(dateColumns);
  const decimalCols = new Set(decimalColumns);
  const colDefs = cols.map((c) => `"${c}" ${inferSqlType(c, seedRows, "postgres", dateCols, decimalCols)}`).join(", ");
  const client = new pg.Client(HOST_PG);
  await client.connect();
  try {
    await client.query(`drop table if exists ${name}`);
    await client.query(`create table ${name} (id integer primary key${colDefs ? `, ${colDefs}` : ""})`);
    if (seedRows.length > 0) {
      const values = seedRows.map((row, i) => `(${i + 1}, ${cols.map((c) => sqlLiteral(row[c])).join(", ")})`).join(", ");
      const colList = cols.map((c) => `"${c}"`).join(", ");
      await client.query(`insert into ${name} (id${colList ? `, ${colList}` : ""}) values ${values}`);
    }
  } finally {
    await client.end();
  }

  const connectionId = await seedConnection("postgres");
  return {
    connectionId,
    scope: { orgId: await getOrgId() },
    // `namespace` means SCHEMA for postgres (queryBuilder.ts quotes it as
    // `"<namespace>"."<name>"`), not the database — the database is already
    // selected via HOST_PG.database/the connection's config.database. The
    // table lives in the default "public" schema of the "sandbox" database.
    table: { namespace: "public", name, keyColumn: "id" },
    async cleanup() {
      const c = new pg.Client(HOST_PG);
      await c.connect();
      try {
        await c.query(`drop table if exists ${name}`);
      } finally {
        await c.end();
      }
    },
  };
}

// ---- mongo --------------------------------------------------------------------

export async function provisionMongoFixture(
  seedRows: Record<string, unknown>[],
  dateColumns: readonly string[] = [],
): Promise<ProvisionedFixture> {
  const name = scratchName("harness_mongo");
  const dateCols = new Set(dateColumns);
  const client = new MongoClient(HOST_MONGO_URI);
  await client.connect();
  try {
    const db = client.db("sandbox");
    await db
      .collection(name)
      .drop()
      .catch(() => {});
    // Mongo is the one dialect where a date-shaped seed string and a real
    // BSON Date are genuinely different wire types (unlike mysql/postgres,
    // where the SQL column's own DDL type — see inferSqlType above — casts
    // the quoted string literal on INSERT). Convert here so a fixture that
    // wants a real Date-typed field gets one; the residual arm keeps
    // reading the original string from testCase.seedRows untouched (see
    // ops-agreement.ts's runResidual), so this conversion is local to the
    // mongo copy only, not a mutation of the caller's seed data. Only for
    // caller-declared `dateColumns` (see the opt-in rationale on
    // inferSqlType above) — a date-shaped string in any other column is
    // left exactly as seeded.
    const docs: Record<string, unknown>[] = seedRows.map((row, i) => {
      const converted: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        converted[k] = dateCols.has(k) && typeof v === "string" && dateShape(v) ? parseDateShapedString(v) : v;
      }
      return { _id: row["_id"] ?? i + 1, ...converted };
    });
    if (docs.length > 0) await db.collection<Record<string, unknown>>(name).insertMany(docs);
  } finally {
    await client.close();
  }

  const connectionId = await seedConnection("mongo");
  return {
    connectionId,
    scope: { orgId: await getOrgId() },
    table: { namespace: "sandbox", name, keyColumn: "_id" },
    async cleanup() {
      const c = new MongoClient(HOST_MONGO_URI);
      await c.connect();
      try {
        await c
          .db("sandbox")
          .collection(name)
          .drop()
          .catch(() => {});
      } finally {
        await c.close();
      }
    },
  };
}

// ---- run compiled query through the real production path ----------------------

/**
 * Runs one already-compiled `DialectQuery` against a provisioned fixture
 * via the real `buildEtlReadQuery` + `dispatch()` production path — the
 * exact pair `runEtl.ts` calls, not a reimplementation.
 */
export async function runCompiledQuery(
  dialect: SourceDialect,
  fixture: { connectionId: string; scope: WorkspaceScope; table: ScratchTable },
  dialectQuery: DialectQuery | null,
): Promise<Record<string, unknown>[]> {
  const query = buildEtlReadQuery(
    dialect,
    { namespace: fixture.table.namespace, name: fixture.table.name },
    dialectQuery,
    fixture.table.keyColumn,
    null,
    MAX_CHUNK_ROWS,
  );
  const result = await dispatch(fixture.connectionId, query, fixture.scope, DEMO_USER_ID);
  if (!result.ok) {
    throw new Error(
      `dispatch failed for ${dialect} scratch table ${fixture.table.name}: ${result.error.kind} — ${result.error.message}`,
    );
  }
  const { columns, rows } = result.value;
  // Fix (numeric group keys under MySQL pagination): mirror
  // runPagedAggregateQuery's stripping below — an aggregate dialectQuery's
  // mysql-only hidden byte-order cursor columns
  // (`dialectQuery.groupCursorColumns`) exist purely for keyset pagination
  // and must never leak into rows a fixture's `dbCase.expectedRows` diffs
  // against.
  const cursorCols = dialectQuery && dialectQuery.dialect !== "mongo" ? dialectQuery.groupCursorColumns : null;
  const hiddenCols = new Set(cursorCols ?? []);
  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      if (hiddenCols.has(c.name)) return;
      obj[c.name] = row[i];
    });
    // The harness-owned key column (`id`/`_id`) exists solely to satisfy
    // buildEtlReadQuery's keyset-pagination precondition — it's never part
    // of a fixture's logical column set (no OP_FIXTURES/AGREEMENT_CASES
    // seed data uses that field name), so callers authoring `expectedRows`
    // shouldn't need to know about it either.
    delete obj[fixture.table.keyColumn];
    return obj;
  });
}

/**
 * Phase 9 Part 3 — actually pages through a pushed aggregate's output,
 * mirroring runEtl.ts's real per-chunk loop (compilePushdown with a
 * SqlGroupKeyCursor folded in -> buildEtlReadQuery -> dispatch -> read the
 * next group-key tuple off the last row) instead of `runCompiledQuery`'s
 * single unpaginated read (which only ever sees one page, capped at
 * MAX_CHUNK_ROWS). Used by the one adversarial live agreement case that
 * needs to prove a small page size (2) doesn't split/duplicate/drop any
 * group — every other aggregate case fits in one page and uses
 * `runCompiledQuery` instead.
 *
 * `config` must compile fully pushed (`residualCount === 0`) and contain
 * exactly one `aggregate` step — callers assert both themselves via
 * `compilePushdown`'s own plan before looping.
 */
export async function runPagedAggregateQuery(
  dialect: SourceDialect,
  fixture: { connectionId: string; scope: WorkspaceScope; table: ScratchTable },
  config: TransformConfig,
  pageSize: number,
): Promise<Record<string, unknown>[]> {
  const aggregateStep = config.steps.find((s): s is Extract<TransformConfig["steps"][number], { kind: "aggregate" }> => s.kind === "aggregate");
  if (!aggregateStep) throw new Error("runPagedAggregateQuery: config has no aggregate step");
  const groupByColumns = aggregateStep.groupBy;

  const allRows: Record<string, unknown>[] = [];
  let groupKeyCursor: SqlGroupKeyCursor | undefined;
  for (;;) {
    const plan = compilePushdown(dialect, config, undefined, groupKeyCursor);
    if (plan.residualCount > 0) throw new Error(`runPagedAggregateQuery: config is not fully pushed for ${dialect} (residualCount ${plan.residualCount})`);
    const query = buildEtlReadQuery(dialect, { namespace: fixture.table.namespace, name: fixture.table.name }, plan.dialectQuery, undefined, null, pageSize);
    const result = await dispatch(fixture.connectionId, query, fixture.scope, DEMO_USER_ID);
    if (!result.ok) {
      throw new Error(
        `paged-aggregate dispatch failed for ${dialect} scratch table ${fixture.table.name}: ${result.error.kind} — ${result.error.message}`,
      );
    }
    const { columns, rows } = result.value;
    // Fix (numeric group keys under MySQL pagination): mirror runEtl.ts's
    // real per-chunk handling exactly — the hidden byte-order cursor
    // columns (mysql-only, `plan.dialectQuery.groupCursorColumns`) exist
    // purely to compute the NEXT page's group-key tuple below and must
    // never leak into the returned rows callers diff against `expectedRows`.
    const cursorCols =
      plan.dialectQuery && plan.dialectQuery.dialect !== "mongo" ? plan.dialectQuery.groupCursorColumns : null;
    const hiddenCols = new Set(cursorCols ?? []);
    for (const row of rows) {
      const obj: Record<string, unknown> = {};
      columns.forEach((c, i) => {
        if (hiddenCols.has(c.name)) return;
        obj[c.name] = row[i];
      });
      allRows.push(obj);
    }
    if (rows.length < pageSize || groupByColumns.length === 0) break;
    const lastRow = rows[rows.length - 1]!;
    const values = groupByColumns.map((col, i) => {
      const cursorCol = cursorCols?.[i] ?? col;
      const idx = columns.findIndex((c) => c.name === cursorCol);
      return idx !== -1 ? (lastRow[idx] as string | number | null) : null;
    });
    groupKeyCursor = { columns: groupByColumns, values };
  }
  return allRows;
}

/**
 * Phase 9 Part 4 — runs one already-compiled `FailurePreCheck.dialectQuery`
 * fragment against a provisioned fixture via the real
 * `buildFailurePreCheckQuery` + `dispatch()` production path (the exact
 * pair `runEtl.ts` calls before extraction, mirrored from
 * `runCompiledQuery` above), returning the parsed failure count.
 */
export async function runFailurePreCheck(
  dialect: SourceDialect,
  fixture: { connectionId: string; scope: WorkspaceScope; table: ScratchTable },
  dialectQuery: FailurePreCheck["dialectQuery"],
): Promise<number> {
  const query = buildFailurePreCheckQuery(dialect, { namespace: fixture.table.namespace, name: fixture.table.name }, dialectQuery);
  const result = await dispatch(fixture.connectionId, query, fixture.scope, DEMO_USER_ID);
  if (!result.ok) {
    throw new Error(
      `pre-check dispatch failed for ${dialect} scratch table ${fixture.table.name}: ${result.error.kind} — ${result.error.message}`,
    );
  }
  const raw = result.value.rows[0]?.[0];
  return typeof raw === "number" ? raw : Number(raw ?? 0);
}

// ---- order-independent row-set diff ------------------------------------------

// Canonical (key-order-independent) JSON: keys sorted before stringifying,
// used for BOTH the sort key and the equality check below — comparing two
// objects with the same keys/values but different insertion order (e.g. a
// mongo $addFields'd column landing before vs. after the source columns)
// must not read as a mismatch.
function canonicalJson(row: Record<string, unknown> | undefined): string {
  if (row === undefined) return "undefined";
  return JSON.stringify(
    Object.keys(row)
      .sort()
      .map((k) => [k, row[k]]),
  );
}

/**
 * Order-independent row-set comparison. Returns human-readable mismatch
 * lines, `[]` if the two row sets are equal (ignoring row order and each
 * row's own key insertion order).
 */
export function diffRows(label: string, actual: Record<string, unknown>[], expected: Record<string, unknown>[]): string[] {
  const lines: string[] = [];
  if (actual.length !== expected.length) {
    lines.push(`${label}: row count mismatch — actual ${actual.length}, expected ${expected.length}`);
  }
  const sortedActual = [...actual].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  const sortedExpected = [...expected].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  const max = Math.max(sortedActual.length, sortedExpected.length);
  for (let i = 0; i < max; i++) {
    const a = sortedActual[i];
    const e = sortedExpected[i];
    if (canonicalJson(a) !== canonicalJson(e)) {
      lines.push(`${label}: row ${i} mismatch — actual ${JSON.stringify(a) ?? "undefined"}, expected ${JSON.stringify(e) ?? "undefined"}`);
    }
  }
  return lines;
}
