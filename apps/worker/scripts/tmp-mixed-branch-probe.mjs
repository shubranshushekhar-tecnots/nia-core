import pg from "pg";
const HOST_PG = { host: "localhost", port: 5433, database: "sandbox", user: "postgres", password: "devroot" };
async function main() {
  const client = new pg.Client(HOST_PG);
  await client.connect();
  try {
    console.log("=== mixed CASE branch: one explicitly CAST AS timestamptz, other a bare untyped param (no adjacent hint) ===");
    try {
      const r = await client.query(
        `select (CASE WHEN true THEN CAST($1 AS timestamptz) ELSE $2 END) AS result`,
        ["2024-01-15", "not-a-date"],
      );
      console.log("  result:", r.rows[0].result);
    } catch (e) {
      console.log("  ERROR:", e.message);
    }
  } finally {
    await client.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
