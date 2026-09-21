/**
 * Phase 8b-2, pre-batch-5 hardening, Item 3 follow-up 2a — does
 * `castAmbiguousLiteral`'s numeric rule (always `CAST(... AS double
 * precision)`, see sqlShared.ts and docs/decisions.md's Item 3 entry)
 * introduce a false-positive equality match when a CASE-branch literal is
 * compared against a real BIGINT column holding a value beyond 2^53 (the
 * point past which not every integer is exactly representable as a
 * float64)?
 *
 * This can't be expressed as a normal `agreementCases.ts` entry:
 * `dbHarness.ts`'s `inferSqlType` always maps a numeric seed column to
 * DOUBLE/double precision (see its doc comment), so the standard harness
 * has no way to provision a genuine BIGINT column — and the seed-row
 * pipeline is JS-number-typed throughout, which would round-trip-corrupt
 * any literal beyond 2^53 before it even reached SQL. This probe bypasses
 * both: it writes the BIGINT column values as literal SQL text directly
 * (never through a JS number), and runs three variants of the same
 * comparison over a raw postgres connection to isolate exactly what this
 * pass's explicit CAST changes relative to (a) the pre-existing untyped-
 * param behavior and (b) a fully-correct typed comparison.
 *
 * Two rows, chosen so they collide under float64 rounding but not under
 * exact bigint comparison:
 *   row 1: big_id = 9007199254740992  (= 2^53, exactly representable)
 *   row 2: big_id = 9007199254740993  (2^53 + 1, NOT exactly representable
 *          as a double — rounds to 9007199254740992, same as row 1)
 *
 * Filter under test: `if(dummy = 1, 9007199254740992, 0) = big_id`. The
 * literal 9007199254740992 is itself exactly representable (no JS-parse
 * precision loss), isolating the question to what postgres's comparison
 * operator resolution does with `bigint = <cast-or-untyped> literal`, not
 * whether the literal itself already lost precision.
 *
 * Three queries against the same two rows:
 *   A) `CAST($1 AS double precision) = big_id`  — what this pass's code
 *      now emits for a CASE branch used in a downstream comparison.
 *   B) `$1 = big_id` (untyped param)            — the pre-Item-3 behavior,
 *      to isolate whether this is a regression or pre-existing.
 *   C) `$1::bigint = big_id`                    — ground truth: a fully
 *      exact bigint comparison, must match only row 1.
 *
 * Run: `pnpm --filter @nia/worker exec tsx scripts/bigint-precision-probe.ts`
 * (no seed/connection/dispatch plumbing needed — raw `pg` client only).
 */
import pg from "pg";

const HOST_PG = { host: "localhost", port: 5433, database: "sandbox", user: "postgres", password: "devroot" };
const LITERAL = 9007199254740992; // 2^53, exactly representable as a JS number / float64

async function main(): Promise<void> {
  const client = new pg.Client(HOST_PG);
  await client.connect();
  const table = `bigint_probe_${Date.now()}`;
  try {
    await client.query(`drop table if exists ${table}`);
    await client.query(`create table ${table} (id integer primary key, dummy double precision, big_id bigint)`);
    // Written as literal SQL text, never through a JS number — the two
    // big_id values are adjacent bigints that collide under float64
    // rounding, and must stay exact on the way into the table.
    await client.query(
      `insert into ${table} (id, dummy, big_id) values (1, 1, 9007199254740992), (2, 1, 9007199254740993)`,
    );

    const queries: Array<{ label: string; sql: string }> = [
      { label: "A) CAST($1 AS double precision) = big_id  [this pass's emitted form]", sql: `select id, big_id from ${table} where CAST($1 AS double precision) = big_id order by id` },
      { label: "B) $1 = big_id  [pre-Item-3 untyped param]", sql: `select id, big_id from ${table} where $1 = big_id order by id` },
      { label: "C) $1::bigint = big_id  [ground truth, exact]", sql: `select id, big_id from ${table} where $1::bigint = big_id order by id` },
    ];

    let anyFalsePositive = false;
    for (const { label, sql } of queries) {
      console.log(`\n=== ${label} ===`);
      try {
        const result = await client.query(sql, [LITERAL]);
        const ids = result.rows.map((r) => r.id);
        console.log(`  rows matched: id=[${ids.join(", ")}]`, JSON.stringify(result.rows));
        if (ids.includes(2)) {
          console.log(`  FALSE POSITIVE: row 2 (big_id=9007199254740993, a genuinely different value) matched too.`);
          if (label.startsWith("A")) anyFalsePositive = true;
        } else if (ids.length === 1 && ids[0] === 1) {
          console.log(`  correct: only row 1 (big_id=9007199254740992) matched.`);
        } else {
          console.log(`  UNEXPECTED: neither/both rows matched in an unanticipated way.`);
        }
      } catch (err) {
        console.log(`  ERROR: ${(err as Error).message}`);
      }
    }

    console.log(
      anyFalsePositive
        ? "\nRESULT: DIVERGENCE — castAmbiguousLiteral's double-precision cast (query A) causes a false-positive bigint match beyond 2^53."
        : "\nRESULT: no false positive from query A — this pass's CAST(... AS double precision) does not corrupt bigint equality in this scenario.",
    );
  } finally {
    await client.query(`drop table if exists ${table}`).catch(() => {});
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
