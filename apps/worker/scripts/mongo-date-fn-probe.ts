/**
 * Phase 8b-2, pre-batch-5 hardening — Addition 2 (mongo date-literal
 * coercion review). Batch 5 is ten date-part call functions (year, month,
 * day, hour, ...). Mongo's native date-extraction operators ($year,
 * $month, $dayOfMonth, $hour, ...) require a Date/Timestamp/ObjectId
 * input by definition — the conditional-branch fix (ISO_DATE_LITERAL_RE +
 * planDateStringCast, scoped to `conditional` only) does not touch `call`
 * expressions at all, so it does nothing for `year("2024-01-15")` or
 * `year(some_text_column)`.
 *
 * This probes what mongo's date operators actually do with:
 *   (a) a raw string field/literal
 *   (b) the same string wrapped in $toDate
 *   (c) a real BSON Date field
 * to confirm whether a type-driven "batch 5's call args always get
 * wrapped in $toDate, unconditionally, because the operator's own
 * contract requires a Date" mechanism is safe and sufficient — and
 * whether it might subsume the conditional-branch fix entirely.
 *
 * Run: `pnpm --filter @nia/worker exec tsx scripts/mongo-date-fn-probe.ts`
 */
import { MongoClient } from "mongodb";

const HOST_MONGO_URI = "mongodb://root:devroot@localhost:27018/sandbox?authSource=admin";

async function tryAgg(label: string, db: import("mongodb").Db, coll: string, pipeline: Record<string, unknown>[]): Promise<void> {
  try {
    const rows = await db.collection(coll).aggregate(pipeline).toArray();
    console.log(`  ${label}: OK -> ${JSON.stringify(rows)}`);
  } catch (err) {
    console.log(`  ${label}: ERROR -> ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  const client = new MongoClient(HOST_MONGO_URI);
  await client.connect();
  const db = client.db("sandbox");
  const coll = `mongo_date_fn_probe_${Date.now()}`;
  try {
    await db.collection(coll).insertMany([
      { _id: 1, d_string: "2024-03-15T10:30:00Z", d_date: new Date("2024-03-15T10:30:00Z") },
    ]);

    console.log("=== (a) raw string field into $year/$month/$dayOfMonth/$hour ===");
    await tryAgg("$year on raw string", db, coll, [{ $project: { v: { $year: "$d_string" } } }]);
    await tryAgg("$month on raw string", db, coll, [{ $project: { v: { $month: "$d_string" } } }]);
    await tryAgg("$dayOfMonth on raw string", db, coll, [{ $project: { v: { $dayOfMonth: "$d_string" } } }]);
    await tryAgg("$hour on raw string", db, coll, [{ $project: { v: { $hour: "$d_string" } } }]);

    console.log("\n=== (b) $toDate-wrapped string field into the same operators ===");
    await tryAgg("$year on $toDate(raw string)", db, coll, [{ $project: { v: { $year: { $toDate: "$d_string" } } } }]);
    await tryAgg("$month on $toDate(raw string)", db, coll, [{ $project: { v: { $month: { $toDate: "$d_string" } } } }]);
    await tryAgg("$dayOfMonth on $toDate(raw string)", db, coll, [{ $project: { v: { $dayOfMonth: { $toDate: "$d_string" } } } }]);
    await tryAgg("$hour on $toDate(raw string)", db, coll, [{ $project: { v: { $hour: { $toDate: "$d_string" } } } }]);

    console.log("\n=== (c) real Date field into the same operators, both bare and $toDate-wrapped ===");
    await tryAgg("$year on real Date field", db, coll, [{ $project: { v: { $year: "$d_date" } } }]);
    await tryAgg("$year on $toDate(real Date field)", db, coll, [{ $project: { v: { $year: { $toDate: "$d_date" } } } }]);

    console.log("\n=== bonus: $toDate on a NON-date-shaped string (does it error, or return something silently wrong?) ===");
    await tryAgg("$toDate('not a date')", db, coll, [{ $project: { v: { $toDate: "not a date" } } }]);
    await tryAgg("$year on $toDate('not a date')", db, coll, [{ $project: { v: { $year: { $toDate: "not a date" } } } }]);

    console.log("\n=== bonus: $toDate on NULL (the null-guard question for a future compileDatePartMongo) ===");
    await tryAgg("$toDate(null)", db, coll, [{ $project: { v: { $toDate: null } } }]);
    await tryAgg("$year on $toDate(null)", db, coll, [{ $project: { v: { $year: { $toDate: null } } } }]);
  } finally {
    await db
      .collection(coll)
      .drop()
      .catch(() => {});
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
