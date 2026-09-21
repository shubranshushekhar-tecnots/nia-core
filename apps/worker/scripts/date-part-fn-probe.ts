/**
 * Phase 8b-2, batch 5 pre-implementation probe. Answers, live, the open
 * design questions the "type-driven date-arg coercion" mechanism needs
 * before any compile-fn / eval-fn code is written:
 *
 *  1) Postgres: what does CAST(col AS text) actually produce for date /
 *     timestamp / timestamptz columns? (determines whether reusing
 *     compileToDateSql's ISO regex as the coercion path is safe for a real
 *     timestamptz column, or whether it needs its own path.)
 *  2) Postgres: does EXTRACT(... FROM col) work directly, with zero
 *     casting, on date/timestamp/timestamptz columns?
 *  3) Postgres: does EXTRACT(... FROM $1) work on a bound (extended
 *     protocol) untyped text parameter holding an ISO string, with no
 *     other type context? (the same "unknown param, no adjacent typed
 *     operand" question castAmbiguousLiteral's doc comment raises,
 *     applied to EXTRACT's argument position instead of a CASE branch.)
 *  4) Postgres: EXTRACT(ISODOW FROM ...) and EXTRACT(QUARTER FROM ...) —
 *     do they exist and return the ISO/1-4 values expected.
 *  5) Mysql: CAST(col AS CHAR) format for DATE/DATETIME columns; does
 *     EXTRACT(... FROM col) work directly; YEAR()/WEEKDAY() functions;
 *     does EXTRACT support QUARTER.
 *  6) Mysql: what happens when YEAR()/EXTRACT is given a non-date-shaped
 *     string — silent NULL+warning, or a hard error?
 *  7) Mongo: does $convert with onError:null/onNull:null avoid the hard
 *     error $toDate throws on a non-date-shaped string (mongo-date-fn-
 *     probe.ts already showed bare $toDate hard-errors there)? Does
 *     $isoDayOfWeek give Mon=1..Sun=7 directly?
 *  8) Timezone: with process.env.TZ set to a non-UTC zone, do mysql's
 *     DATETIME (tz-naive) and postgres's timestamptz (tz-aware) extraction
 *     results actually diverge the way the batch description predicts,
 *     confirming this needs live non-UTC coverage rather than being moot?
 *
 * Run: `pnpm --filter @nia/worker exec tsx scripts/date-part-fn-probe.ts`
 */
import mysql from "mysql2/promise";
import pg from "pg";
import { MongoClient } from "mongodb";

const HOST_MYSQL = { host: "127.0.0.1", port: 3307, user: "root", password: "devroot", database: "sandbox" };
const HOST_PG = { host: "localhost", port: 5433, database: "sandbox", user: "postgres", password: "devroot" };
const HOST_MONGO_URI = "mongodb://root:devroot@localhost:27018/sandbox?authSource=admin";

async function main(): Promise<void> {
  console.log(`process.env.TZ = ${process.env.TZ ?? "(unset)"}, Intl default TZ = ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);

  // ---------------- Postgres ----------------
  const pgClient = new pg.Client(HOST_PG);
  await pgClient.connect();
  const pgTable = `date_part_probe_${Date.now()}`;
  try {
    await pgClient.query(`drop table if exists ${pgTable}`);
    await pgClient.query(
      `create table ${pgTable} (id integer primary key, d date, ts timestamp, tstz timestamptz, txt text)`,
    );
    await pgClient.query(
      `insert into ${pgTable} (id, d, ts, tstz, txt) values (1, '2024-01-15', '2024-01-15 10:30:45', '2024-01-15T10:30:45Z', '2024-01-15T10:30:45Z')`,
    );

    console.log("\n=== Postgres: CAST(col AS text) format ===");
    for (const col of ["d", "ts", "tstz"]) {
      const r = await pgClient.query(`select CAST(${col} AS text) as v from ${pgTable} where id=1`);
      console.log(`  CAST(${col} AS text) -> ${JSON.stringify(r.rows[0].v)}`);
    }

    console.log("\n=== Postgres: EXTRACT direct on typed columns (no cast) ===");
    for (const col of ["d", "ts", "tstz"]) {
      try {
        const r = await pgClient.query(`select EXTRACT(YEAR FROM ${col}) as y, EXTRACT(HOUR FROM ${col}) as h from ${pgTable} where id=1`);
        console.log(`  EXTRACT(YEAR/HOUR FROM ${col}) -> y=${r.rows[0].y}, h=${r.rows[0].h}`);
      } catch (err) {
        console.log(`  EXTRACT FROM ${col} -> ERROR: ${(err as Error).message}`);
      }
    }

    console.log("\n=== Postgres: EXTRACT on a bound untyped text param (extended protocol, no adjacent typed operand) ===");
    try {
      const r = await pgClient.query(`select EXTRACT(YEAR FROM $1) as y`, ["2024-01-15T10:30:45Z"]);
      console.log(`  EXTRACT(YEAR FROM $1) with param="2024-01-15T10:30:45Z" -> OK, y=${r.rows[0].y}`);
    } catch (err) {
      console.log(`  EXTRACT(YEAR FROM $1) -> ERROR: ${(err as Error).message}`);
    }
    console.log("\n=== Postgres: EXTRACT on a bound param explicitly CAST to timestamptz ===");
    try {
      const r = await pgClient.query(`select EXTRACT(YEAR FROM CAST($1 AS timestamptz)) as y`, ["2024-01-15T10:30:45Z"]);
      console.log(`  EXTRACT(YEAR FROM CAST($1 AS timestamptz)) -> OK, y=${r.rows[0].y}`);
    } catch (err) {
      console.log(`  -> ERROR: ${(err as Error).message}`);
    }
    console.log("  Same CAST, but with garbage text:");
    try {
      const r = await pgClient.query(`select EXTRACT(YEAR FROM CAST($1 AS timestamptz)) as y`, ["not a date"]);
      console.log(`  -> OK (unexpected), y=${r.rows[0].y}`);
    } catch (err) {
      console.log(`  -> ERROR: ${(err as Error).message}`);
    }
    console.log("  Same CAST, but with a TEXT COLUMN (not a bound param) holding ISO content:");
    try {
      const r = await pgClient.query(`select EXTRACT(YEAR FROM CAST(txt AS timestamptz)) as y from ${pgTable} where id=1`);
      console.log(`  -> OK, y=${r.rows[0].y}`);
    } catch (err) {
      console.log(`  -> ERROR: ${(err as Error).message}`);
    }

    console.log("\n=== Postgres: ISODOW / QUARTER ===");
    const r1 = await pgClient.query(`select EXTRACT(ISODOW FROM CAST('2024-01-15' AS date)) as dow`); // Monday
    console.log(`  EXTRACT(ISODOW FROM '2024-01-15' [Monday]) -> ${r1.rows[0].dow} (expect 1)`);
    const r2 = await pgClient.query(`select EXTRACT(ISODOW FROM CAST('2024-01-21' AS date)) as dow`); // Sunday
    console.log(`  EXTRACT(ISODOW FROM '2024-01-21' [Sunday]) -> ${r2.rows[0].dow} (expect 7)`);
    const r3 = await pgClient.query(`select EXTRACT(QUARTER FROM CAST('2024-05-15' AS date)) as q`);
    console.log(`  EXTRACT(QUARTER FROM '2024-05-15') -> ${r3.rows[0].q} (expect 2)`);

    console.log("\n=== Postgres: EXTRACT(EPOCH FROM tstz1 - tstz2) for diff arithmetic ===");
    const r4 = await pgClient.query(
      `select EXTRACT(EPOCH FROM (CAST('2024-03-01T00:00:00Z' AS timestamptz) - CAST('2024-01-01T00:00:00Z' AS timestamptz))) as secs`,
    );
    console.log(`  epoch diff Mar1-Jan1 -> ${r4.rows[0].secs} seconds`);

    console.log("\n=== Postgres: non-UTC session TZ effect on EXTRACT(HOUR FROM tstz) vs EXTRACT(HOUR FROM ts) ===");
    await pgClient.query(`set time zone 'America/New_York'`);
    const r5 = await pgClient.query(`select EXTRACT(HOUR FROM tstz) as h_tstz, EXTRACT(HOUR FROM ts) as h_ts from ${pgTable} where id=1`);
    console.log(`  session TZ=America/New_York: EXTRACT(HOUR FROM tstz)=${r5.rows[0].h_tstz} (tstz stored as 10:30:45Z), EXTRACT(HOUR FROM ts)=${r5.rows[0].h_ts} (ts stored naive 10:30:45, expect unchanged)`);
    await pgClient.query(`set time zone 'UTC'`);
  } finally {
    await pgClient.query(`drop table if exists ${pgTable}`).catch(() => {});
    await pgClient.end();
  }

  // ---------------- Mysql ----------------
  const myConn = await mysql.createConnection(HOST_MYSQL);
  const myTable = `date_part_probe_${Date.now()}`;
  try {
    await myConn.query(`drop table if exists ${myTable}`);
    await myConn.query(`create table ${myTable} (id integer primary key, d date, dt datetime, txt varchar(255))`);
    await myConn.query(
      `insert into ${myTable} (id, d, dt, txt) values (1, '2024-01-15', '2024-01-15 10:30:45', '2024-01-15T10:30:45Z')`,
    );

    console.log("\n=== Mysql: CAST(col AS CHAR) format ===");
    for (const col of ["d", "dt"]) {
      const [rows] = await myConn.query(`select CAST(${col} AS CHAR) as v from ${myTable} where id=1`);
      console.log(`  CAST(${col} AS CHAR) -> ${JSON.stringify((rows as { v: string }[])[0].v)}`);
    }

    console.log("\n=== Mysql: EXTRACT direct on typed columns ===");
    for (const col of ["d", "dt"]) {
      const [rows] = await myConn.query(`select EXTRACT(YEAR FROM ${col}) as y, EXTRACT(HOUR FROM ${col}) as h from ${myTable} where id=1`);
      console.log(`  EXTRACT(YEAR/HOUR FROM ${col}) -> ${JSON.stringify((rows as unknown[])[0])}`);
    }

    console.log("\n=== Mysql: EXTRACT/YEAR on a bound param holding an ISO string ===");
    try {
      const [rows] = await myConn.query(`select EXTRACT(YEAR FROM ?) as y`, ["2024-01-15T10:30:45Z"]);
      console.log(`  EXTRACT(YEAR FROM ?) -> OK, ${JSON.stringify((rows as unknown[])[0])}`);
    } catch (err) {
      console.log(`  -> ERROR: ${(err as Error).message}`);
    }

    console.log("\n=== Mysql: EXTRACT/YEAR on a NON-date-shaped string (error vs silent NULL) ===");
    try {
      const [rows] = await myConn.query(`select EXTRACT(YEAR FROM ?) as y`, ["not a date"]);
      console.log(`  EXTRACT(YEAR FROM 'not a date') -> OK (no throw), ${JSON.stringify((rows as unknown[])[0])}`);
    } catch (err) {
      console.log(`  -> ERROR: ${(err as Error).message}`);
    }
    try {
      const [rows] = await myConn.query(`select YEAR(?) as y`, ["not a date"]);
      console.log(`  YEAR('not a date') -> OK (no throw), ${JSON.stringify((rows as unknown[])[0])}`);
    } catch (err) {
      console.log(`  -> ERROR: ${(err as Error).message}`);
    }

    console.log("\n=== Mysql: EXTRACT(QUARTER FROM ...), WEEKDAY() (0=Mon..6=Sun) ===");
    const [rq] = await myConn.query(`select EXTRACT(QUARTER FROM CAST('2024-05-15' AS date)) as q`);
    console.log(`  EXTRACT(QUARTER FROM '2024-05-15') -> ${JSON.stringify((rq as unknown[])[0])} (expect 2)`);
    const [rw1] = await myConn.query(`select WEEKDAY(CAST('2024-01-15' AS date)) as wd`); // Monday
    console.log(`  WEEKDAY('2024-01-15' [Monday]) -> ${JSON.stringify((rw1 as unknown[])[0])} (expect 0)`);
    const [rw2] = await myConn.query(`select WEEKDAY(CAST('2024-01-21' AS date)) as wd`); // Sunday
    console.log(`  WEEKDAY('2024-01-21' [Sunday]) -> ${JSON.stringify((rw2 as unknown[])[0])} (expect 6)`);

    console.log("\n=== Mysql: TIMESTAMPDIFF for epoch-seconds equivalent, and month-end ADD ===");
    const [rd] = await myConn.query(
      `select TIMESTAMPDIFF(SECOND, CAST('2024-01-01T00:00:00Z' AS DATETIME), CAST('2024-03-01T00:00:00Z' AS DATETIME)) as secs`,
    );
    console.log(`  TIMESTAMPDIFF(SECOND, Jan1, Mar1) -> ${JSON.stringify((rd as unknown[])[0])}`);
    const [ra] = await myConn.query(`select DATE_ADD(CAST('2024-01-31' AS date), INTERVAL 1 MONTH) as v`);
    console.log(`  DATE_ADD('2024-01-31', INTERVAL 1 MONTH) [native, for comparison only, NOT what we'll ship] -> ${JSON.stringify((ra as unknown[])[0])}`);

    console.log("\n=== Mysql: session time_zone effect on HOUR(dt) [naive DATETIME] ===");
    await myConn.query(`set time_zone = '+00:00'`);
    const [rh1] = await myConn.query(`select HOUR(dt) as h from ${myTable} where id=1`);
    await myConn.query(`set time_zone = '-05:00'`);
    const [rh2] = await myConn.query(`select HOUR(dt) as h from ${myTable} where id=1`);
    console.log(`  HOUR(dt) at session tz +00:00 -> ${JSON.stringify((rh1 as unknown[])[0])}; at -05:00 -> ${JSON.stringify((rh2 as unknown[])[0])} (naive DATETIME: expect UNCHANGED, mysql does not reinterpret it)`);
  } finally {
    await myConn.query(`drop table if exists ${myTable}`).catch(() => {});
    await myConn.end();
  }

  // ---------------- Mongo ----------------
  const mongoClient = new MongoClient(HOST_MONGO_URI);
  await mongoClient.connect();
  const db = mongoClient.db("sandbox");
  const coll = `date_part_probe_${Date.now()}`;
  try {
    await db.collection(coll).insertMany([
      { _id: 1, d_string: "2024-01-15T10:30:45Z", d_date: new Date("2024-01-15T10:30:45Z"), d_bad: "not a date", d_null: null },
    ]);

    console.log("\n=== Mongo: $convert onError:null/onNull:null vs bare $toDate ===");
    async function tryAgg(label: string, pipeline: Record<string, unknown>[]): Promise<void> {
      try {
        const rows = await db.collection(coll).aggregate(pipeline).toArray();
        console.log(`  ${label}: OK -> ${JSON.stringify(rows)}`);
      } catch (err) {
        console.log(`  ${label}: ERROR -> ${(err as Error).message}`);
      }
    }
    const conv = (input: string) => ({ $convert: { input, to: "date", onError: null, onNull: null } });
    await tryAgg("$convert(d_string) onError:null", [{ $project: { v: conv("$d_string") } }]);
    await tryAgg("$convert(d_bad) onError:null [should be null, not throw]", [{ $project: { v: conv("$d_bad") } }]);
    await tryAgg("$convert(d_null) onError:null/onNull:null", [{ $project: { v: conv("$d_null") } }]);
    await tryAgg("$year of $convert(d_bad)", [{ $project: { v: { $year: conv("$d_bad") } } }]);
    await tryAgg("$year of $convert(d_string)", [{ $project: { v: { $year: conv("$d_string") } } }]);

    console.log("\n=== Mongo: $isoDayOfWeek / quarter-via-month ===");
    await tryAgg("$isoDayOfWeek on 2024-01-15 (Monday)", [{ $project: { v: { $isoDayOfWeek: new Date("2024-01-15T00:00:00Z") } } }]);
    await tryAgg("$isoDayOfWeek on 2024-01-21 (Sunday)", [{ $project: { v: { $isoDayOfWeek: new Date("2024-01-21T00:00:00Z") } } }]);
    await tryAgg("$ceil($divide[$month,3]) quarter calc for month=5", [
      { $project: { v: { $ceil: { $divide: [5, 3] } } } },
    ]);

    console.log("\n=== Mongo: $subtract of two Dates -> ms; $dateAdd availability ===");
    await tryAgg("$subtract(Mar1, Jan1) in ms", [
      { $project: { v: { $subtract: [new Date("2024-03-01T00:00:00Z"), new Date("2024-01-01T00:00:00Z")] } } },
    ]);
    await tryAgg("$dateAdd month, amount 1, startDate=2024-01-31", [
      { $project: { v: { $dateAdd: { startDate: new Date("2024-01-31T00:00:00Z"), unit: "month", amount: 1 } } } },
    ]);
  } finally {
    await db
      .collection(coll)
      .drop()
      .catch(() => {});
    await mongoClient.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
