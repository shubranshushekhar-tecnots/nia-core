/**
 * Phase 8b-2, pre-batch-5 hardening, Item 3 follow-up 3 — before batch 5
 * introduces the first date-typed literals, confirm two things live
 * against real postgres:
 *
 *   1) What `castAmbiguousLiteral` does with a date-shaped string literal
 *      TODAY (code fact, no live test needed): its type switch only
 *      branches on `typeof expr.value === "number"` and `"boolean"` — a
 *      string literal (which is what an ISO-8601 date is represented as
 *      in this grammar; there is no separate date-literal AST node) falls
 *      through untouched, same no-op path Condition 2 already proved safe
 *      for a plain string with no adjacent typed operand at all.
 *
 *   2) Whether that no-op is STILL safe once the string is date-shaped and
 *      used in a context that requires date/timestamp type resolution — a
 *      new question date literals raise that a plain text literal (Item 3
 *      Condition 2's `substitute()` case) doesn't: is Postgres's "infer
 *      from context" behavior for the *conditional* (CASE) construct
 *      strong enough to resolve an untyped param to `date`/`timestamptz`
 *      the same way Condition 2 showed it resolves to `text`? Batch 5
 *      doesn't exist yet, so this probe manufactures the shape directly:
 *      a CASE (conditional) whose branches are bare ISO-8601 string
 *      literals, compared via `=` against a real `date` column — the
 *      same "conditional literal compared to a typed column" shape as
 *      the bigint probe, substituting `date` for `bigint`.
 *
 * Run: `pnpm --filter @nia/worker exec tsx scripts/date-literal-cast-probe.ts`
 */
import pg from "pg";
import { compilePushdown, parseExpression, type TransformConfig } from "@nia/schemas";

const HOST_PG = { host: "localhost", port: 5433, database: "sandbox", user: "postgres", password: "devroot" };

async function main(): Promise<void> {
  // --- Part 1: confirm the no-op via the actual compiled SQL, not just
  // the source read (belt-and-suspenders — prints the real output). ---
  const filterExpr = 'if(dummy = 1, "2024-01-15", "2024-01-01") = "2024-01-15"';
  const parsed = parseExpression(filterExpr);
  if (!parsed.ok) throw new Error(parsed.error);
  const config: TransformConfig = { steps: [{ kind: "filter", expr: parsed.expr }] };
  const plan = compilePushdown("postgres", config);
  console.log("=== Part 1: compiled postgres SQL for a date-shaped CASE branch ===");
  console.log(JSON.stringify(plan.dialectQuery, null, 2));
  const sql = plan.dialectQuery as Extract<typeof plan.dialectQuery, { whereSql: string | null }>;
  const noCastEmitted = !sql.whereSql?.includes("CAST(");
  console.log(noCastEmitted ? "  CONFIRMED: no CAST(...) emitted for the date-shaped string branches (no-op, as castAmbiguousLiteral's code predicts).\n" : "  UNEXPECTED: a CAST(...) was emitted.\n");

  // --- Part 2: does that no-op resolve correctly against a real `date`
  // column with no other type hint in the query at all? ---
  const client = new pg.Client(HOST_PG);
  await client.connect();
  const table = `date_probe_${Date.now()}`;
  try {
    await client.query(`drop table if exists ${table}`);
    await client.query(`create table ${table} (id integer primary key, dummy double precision, event_date date)`);
    await client.query(`insert into ${table} (id, dummy, event_date) values (1, 1, '2024-01-15'), (2, 1, '2024-02-20')`);

    console.log("=== Part 2: CASE-branch date-shaped string literal compared to a real `date` column, no explicit cast ===");
    const queries: Array<{ label: string; sql: string; params: unknown[] }> = [
      {
        label: "A) CASE WHEN dummy=1 THEN $1 ELSE $2 END = event_date  [today's no-op form]",
        sql: `select id, event_date from ${table} where (CASE WHEN dummy = 1 THEN $1 ELSE $2 END) = event_date order by id`,
        params: ["2024-01-15", "2024-01-01"],
      },
      {
        label: "B) same, but each branch explicitly CAST(... AS date)  [what a date cast branch would look like]",
        sql: `select id, event_date from ${table} where (CASE WHEN dummy = 1 THEN CAST($1 AS date) ELSE CAST($2 AS date) END) = event_date order by id`,
        params: ["2024-01-15", "2024-01-01"],
      },
    ];

    for (const { label, sql: q, params } of queries) {
      console.log(`\n--- ${label} ---`);
      try {
        const result = await client.query(q, params);
        console.log(`  rows matched: id=[${result.rows.map((r) => r.id).join(", ")}]`, JSON.stringify(result.rows));
      } catch (err) {
        console.log(`  ERROR: ${(err as Error).message}`);
      }
    }

    // --- Part 3: the specific 8b-2a bug shape (same param used in an IS
    // NULL check AND a value/truth position within the same CASE) — does
    // it reproduce for a date-shaped string the way it did for boolean? ---
    console.log("\n=== Part 3: 8b-2a's specific bug shape (IS NULL check + typed-position use of the same untyped param) for a date literal ===");
    const shapeQueries: Array<{ label: string; sql: string; params: unknown[] }> = [
      {
        label: "C) CASE WHEN $1 IS NULL THEN NULL WHEN dummy=1 THEN $1 ELSE event_date END = event_date",
        sql: `select id from ${table} where (CASE WHEN $1 IS NULL THEN NULL WHEN dummy = 1 THEN $1 ELSE event_date END) = event_date order by id`,
        params: ["2024-01-15"],
      },
    ];
    for (const { label, sql: q, params } of shapeQueries) {
      console.log(`\n--- ${label} ---`);
      try {
        const result = await client.query(q, params);
        console.log(`  rows matched: id=[${result.rows.map((r) => r.id).join(", ")}]`, JSON.stringify(result.rows));
      } catch (err) {
        console.log(`  ERROR: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query(`drop table if exists ${table}`).catch(() => {});
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
