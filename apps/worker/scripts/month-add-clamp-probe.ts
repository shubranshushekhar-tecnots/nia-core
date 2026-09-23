/**
 * Phase 8b-2, batch 5 — one-off probe (not part of the shipped implementation):
 * does native month/year interval arithmetic CLAMP to the last valid day, or
 * OVERFLOW into the next month, on each engine? Prints raw CAST-to-text
 * results only (never round-trips through a JS Date/driver parser) to avoid
 * any timezone-interpretation ambiguity in the printed output itself.
 *
 * Run: `pnpm --filter @nia/worker exec tsx scripts/month-add-clamp-probe.ts`
 */
import mysql from "mysql2/promise";
import pg from "pg";
import { MongoClient } from "mongodb";

const HOST_MYSQL = { host: "127.0.0.1", port: 3307, user: "root", password: "devroot", database: "sandbox" };
const HOST_PG = { host: "localhost", port: 5433, database: "sandbox", user: "postgres", password: "devroot" };
const HOST_MONGO_URI = "mongodb://root:devroot@localhost:27018/sandbox?authSource=admin";

async function main(): Promise<void> {
  console.log("=== Mysql: DATE_ADD('2024-01-31', INTERVAL 1 MONTH), raw text ===");
  const myConn = await mysql.createConnection(HOST_MYSQL);
  try {
    const [rows] = await myConn.query(
      `select CAST(DATE_ADD(CAST('2024-01-31' AS date), INTERVAL 1 MONTH) AS CHAR) as v`,
    );
    console.log(`  -> ${JSON.stringify((rows as { v: string }[])[0].v)}`);
    const [rows2] = await myConn.query(
      `select CAST(DATE_ADD(CAST('2023-01-31' AS date), INTERVAL 1 MONTH) AS CHAR) as v`, // 2023 non-leap
    );
    console.log(`  DATE_ADD('2023-01-31'[non-leap], INTERVAL 1 MONTH) -> ${JSON.stringify((rows2 as { v: string }[])[0].v)}`);
  } finally {
    await myConn.end();
  }

  console.log("\n=== Postgres: '2024-01-31'::date + INTERVAL '1 month', raw text ===");
  const pgClient = new pg.Client(HOST_PG);
  await pgClient.connect();
  try {
    const r = await pgClient.query(`select CAST((CAST('2024-01-31' AS date) + INTERVAL '1 month') AS text) as v`);
    console.log(`  -> ${JSON.stringify(r.rows[0].v)}`);
    const r2 = await pgClient.query(`select CAST((CAST('2023-01-31' AS date) + INTERVAL '1 month') AS text) as v`);
    console.log(`  2023-01-31[non-leap] + 1 month -> ${JSON.stringify(r2.rows[0].v)}`);
  } finally {
    await pgClient.end();
  }

  console.log("\n=== Mongo: $dateAdd month, startDate=2023-01-31 (non-leap year) ===");
  const mongoClient = new MongoClient(HOST_MONGO_URI);
  await mongoClient.connect();
  try {
    const db = mongoClient.db("sandbox");
    const rows = await db
      .collection("month_add_clamp_probe")
      .aggregate([
        { $documents: [{ _id: 1 }] },
        { $project: { v: { $dateAdd: { startDate: new Date("2023-01-31T00:00:00Z"), unit: "month", amount: 1 } } } },
      ])
      .toArray();
    console.log(`  -> ${JSON.stringify(rows)}`);
  } finally {
    await mongoClient.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
