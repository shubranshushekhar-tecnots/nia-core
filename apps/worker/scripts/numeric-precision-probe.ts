/**
 * Phase 8b-2, pre-batch-5 hardening, Item 2 — live evidence for the
 * numeric-precision PLATFORM constraint recorded in docs/decisions.md's
 * Item 2 entry.
 *
 * `pool-manager.ts` registers `pg.types.setTypeParser(1700, parseFloat)`
 * so postgres's `numeric`/`decimal` columns return a JS `number`, matching
 * mysql's/mongo's drivers (which already return JS `number` for their
 * equivalent types). `parseFloat` is a float64 conversion, so any value
 * with more significant digits than a float64 mantissa can hold (~15-17
 * decimal digits), or any exact integer above 2^53
 * (Number.MAX_SAFE_INTEGER + 1), silently rounds on read.
 *
 * This probe seeds real postgres `numeric` values covering both risk axes
 * — one value with more than 17 significant digits, one integer above
 * 2^53 — and prints exactly what's lost, comparing the exact value
 * postgres stored (read back as `::text`, bypassing any type parser)
 * against what the registered `parseFloat` parser actually returns.
 *
 * Kept in the repo permanently (not a one-off scratch script), mirroring
 * date-literal-cast-probe.ts's precedent — re-run this any time the
 * numeric-precision constraint needs to be re-demonstrated or re-verified
 * after a driver/parser change.
 *
 * Run: `pnpm --filter @nia/worker exec tsx scripts/numeric-precision-probe.ts`
 */
import pg from "pg";

pg.types.setTypeParser(1700, (val: string) => parseFloat(val));

const HOST_PG = { host: "localhost", port: 5433, database: "sandbox", user: "postgres", password: "devroot" };

const TEST_VALUES = [
  "123456789012345678.123456789", // 27 significant digits, well above 2^53
  "9007199254740993", // 2^53 + 1 — the exact float64-safe-integer boundary
  "12345678901234567890", // 20-digit integer, no fractional part
  "0.12345678901234567890123456789", // 29 significant digits, fraction only
];

async function main(): Promise<void> {
  const client = new pg.Client(HOST_PG);
  await client.connect();
  const table = `numeric_precision_probe_${Date.now()}`;
  try {
    await client.query(`drop table if exists ${table}`);
    await client.query(`create table ${table} (id integer primary key, val numeric)`);
    for (let i = 0; i < TEST_VALUES.length; i++) {
      await client.query(`insert into ${table} (id, val) values ($1, $2::numeric)`, [i + 1, TEST_VALUES[i]]);
    }

    // Read back via the registered parseFloat parser (what pool-manager.ts's
    // real connector dispatch path actually returns to callers).
    const parsed = await client.query(`select id, val from ${table} order by id`);

    // Read back the exact stored value as text, bypassing any numeric type
    // parser, to see what postgres actually persisted.
    const raw = await client.query(`select id, val::text as val_text from ${table} order by id`);

    console.log("=== numeric precision probe: exact (postgres) vs parseFloat (pool-manager.ts) ===\n");
    let anyLossy = false;
    for (let i = 0; i < TEST_VALUES.length; i++) {
      const exact = raw.rows[i].val_text as string;
      const lossy = parsed.rows[i].val as number;
      const lossless = String(lossy) === exact;
      if (!lossless) anyLossy = true;
      console.log(`input:               ${TEST_VALUES[i]}`);
      console.log(`  exact (postgres):  ${exact}`);
      console.log(`  parseFloat result: ${lossy}`);
      console.log(`  lossless?          ${lossless ? "yes" : "NO — precision lost"}\n`);
    }
    console.log(
      anyLossy
        ? "CONFIRMED: parseFloat loses precision on high-significant-digit and >2^53 numeric values — see docs/decisions.md's Item 2 entry for the platform-constraint decision."
        : "UNEXPECTED: no precision loss observed — re-check the type parser registration and these test values.",
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
