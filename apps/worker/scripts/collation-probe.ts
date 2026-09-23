/**
 * Phase 8b-2, Batch 0 — collation probe on every string-comparing operator
 * in the current op vocabulary. Started as a single `=` probe (Fix 4 had
 * already covered `contains`); confirmed positive (mysql's default column
 * collation is case-insensitive, postgres/mongo/residual are all
 * case-sensitive/byte-wise and agree with each other). Widened per the
 * "fix everything in one pass" instruction to also cover `<>`/`!=` (must
 * move in lockstep with `=` — see FIX_CASES's eq/neq pairing) and the
 * ordering operators `<`/`<=`/`>`/`>=` (collation affects sort order even
 * with no equality involved — the case most likely to be silently wrong).
 *
 * `in`/`not_in` and `starts_with`/`ends_with` are NOT in the current op
 * vocabulary (FilterOperator in nodeConfig.ts: eq/neq/gt/gte/lt/lte/
 * contains/is_null/is_not_null only) — nothing to probe for those yet;
 * `contains` itself was already fixed under Fix 4 and is deliberately not
 * re-probed here (out of scope for this regression check, which targets
 * the base comparison operators only).
 *
 * Stays in the repo as a permanent regression check (not a one-off) —
 * re-run any time a new string-comparing operator is added to the
 * vocabulary, or the mysql adapter's collation handling is touched.
 */
import { compilePushdown, applyResidualTransforms, parseExpression, type TransformConfig, type SourceDialect } from "@nia/schemas";
import { provisionMysqlFixture, provisionPostgresFixture, provisionMongoFixture, runCompiledQuery, diffRows, type ProvisionedFixture } from "./lib/dbHarness.js";

// Mixed-case, single-char values chosen so ASCII/byte-wise ordering
// (uppercase block A-Z all sort before lowercase block a-z) and a
// case-insensitive/dictionary ordering (A~a, B~b, ...) diverge on the
// ordering operators, not just equality — e.g. "a" > "B" is true
// byte-wise (97 > 66) but false case-insensitively (A is not > B).
const seedRows = [{ v: "a" }, { v: "A" }, { v: "B" }, { v: "z" }, { v: "Z" }, { v: "b" }];

const PROBE_CASES: Array<{ label: string; expr: string }> = [
  { label: "eq", expr: 'v = "b"' },
  { label: "neq", expr: 'v != "b"' },
  { label: "gt", expr: 'v > "B"' },
  { label: "gte", expr: 'v >= "B"' },
  { label: "lt", expr: 'v < "B"' },
  { label: "lte", expr: 'v <= "B"' },
];

function buildConfig(expr: string): TransformConfig {
  const parsed = parseExpression(expr);
  if (!parsed.ok) throw new Error(`probe expr failed to parse: ${expr}: ${parsed.error}`);
  return { steps: [{ kind: "filter", expr: parsed.expr }] };
}

async function provisionFor(dialect: SourceDialect): Promise<ProvisionedFixture> {
  if (dialect === "mysql") return provisionMysqlFixture(seedRows);
  if (dialect === "postgres") return provisionPostgresFixture(seedRows);
  return provisionMongoFixture(seedRows);
}

function runResidual(config: TransformConfig): Record<string, unknown>[] {
  const cols = ["v"];
  const rows = seedRows.map((row) => cols.map((c) => (row as Record<string, unknown>)[c] ?? null));
  const result = applyResidualTransforms(cols, rows, config.steps);
  return result.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    result.columns.forEach((c, i) => {
      obj[c] = row[i];
    });
    return obj;
  });
}

async function runCase(label: string, expr: string): Promise<boolean> {
  console.log(`=== ${label}: ${expr} against seed [${seedRows.map((r) => r.v).join(", ")}] ===`);
  const config = buildConfig(expr);
  const dialects: SourceDialect[] = ["mysql", "postgres", "mongo"];
  const results: Partial<Record<SourceDialect | "residual", Record<string, unknown>[]>> = {};
  const cleanups: Array<() => Promise<void>> = [];

  for (const dialect of dialects) {
    const provisioned = await provisionFor(dialect);
    cleanups.push(provisioned.cleanup);
    const plan = compilePushdown(dialect, config);
    if (plan.residualCount > 0) {
      console.log(`  WARN  ${dialect}: not fully pushed down (${plan.residualCount} residual) — skipping`);
      continue;
    }
    const rows = await runCompiledQuery(dialect, provisioned, plan.dialectQuery);
    results[dialect] = rows;
    console.log(`  ${dialect.padEnd(10)} -> ${JSON.stringify(rows)}`);
  }
  results.residual = runResidual(config);
  console.log(`  ${"residual".padEnd(10)} -> ${JSON.stringify(results.residual)}`);

  const arms = [...dialects, "residual" as const].filter((a) => results[a] !== undefined);
  let divergent = false;
  for (let i = 0; i < arms.length; i++) {
    for (let j = i + 1; j < arms.length; j++) {
      const a = arms[i]!;
      const b = arms[j]!;
      const mismatches = diffRows(`${a} vs ${b}`, results[a]!, results[b]!);
      if (mismatches.length > 0) {
        divergent = true;
        for (const m of mismatches) console.log(`  DIVERGE  ${m}`);
      }
    }
  }
  console.log(divergent ? `  RESULT: DIVERGENCE\n` : `  RESULT: agree\n`);

  for (const cleanup of cleanups) await cleanup().catch(() => {});
  return divergent;
}

async function main(): Promise<void> {
  let anyDivergence = false;
  for (const { label, expr } of PROBE_CASES) {
    const divergent = await runCase(label, expr);
    if (divergent) anyDivergence = true;
  }
  console.log(anyDivergence ? "OVERALL: DIVERGENCE FOUND on at least one operator." : "OVERALL: ALL OPERATORS AGREE across mysql/postgres/mongo/residual.");
  if (anyDivergence) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
