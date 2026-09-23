/**
 * Phase 8b-2a, Deliverable 3 — three/four-evaluator agreement report.
 *
 * For each AGREEMENT_CASES entry (apps/worker/scripts/lib/agreementCases.ts),
 * runs the SAME seed rows and the SAME filter expression through 4
 * independent evaluators:
 *   - mysql pushdown    (compilePushdown("mysql", ...)    -> real dispatch)
 *   - postgres pushdown (compilePushdown("postgres", ...) -> real dispatch)
 *   - mongo pushdown    (compilePushdown("mongo", ...)    -> real dispatch)
 *   - residual          (applyResidualTransforms, in-process, no DB)
 * then diffs every pair (6 pairs) via dbHarness's diffRows and prints an
 * explicit divergence report. Updated Phase 8b-2b: all 8 divergences this
 * harness originally found (NULL-comparison, NULL-logical, is_number/
 * is_text true-type vs content-based, contains case-sensitivity) were
 * fixed, not declared — see docs/decisions.md's "Phase 8b-2b: Semantics
 * homogenization" entry and the standing principle above it. Every case in
 * agreementCases.ts is now expected to AGREE across all 4 evaluators; a
 * printed divergence means either a real regression (fix it) or a newly
 * discovered genuinely-impossible-compliance case (stop and report before
 * fixing anything, then declare it explicitly in docs/decisions.md per the
 * standing principle — never leave it as a silent disagreement).
 *
 * Updated (pre-batch-5 hardening, Addition 1): errors are now caught PER
 * DIALECT, not per-case. A case where one dialect hard-errors (e.g.
 * postgres's timestamptz-vs-text operator error) no longer aborts that
 * case's whole evaluation before the other arms even run — every other
 * arm still computes and still participates in the pairwise diff, and the
 * error is logged inline (`ERROR <arm>: ...`) alongside any DIVERGE
 * lines. This is required, not cosmetic: a case can legitimately need
 * BOTH a loud per-dialect error AND a silent divergence between the
 * *other* arms to be visible in the same run to be honestly reported
 * (see agreementCases.ts's "FALSE POSITIVE" case). An errored arm is
 * excluded from the pairwise diff (nothing to compare) but always counted
 * toward the final tally, so "ALL CASES AGREE, NO ERRORS" can never print
 * while an arm actually errored.
 *
 * Prerequisites: same as ops-db-conformance.ts / dispatch-smoke.ts —
 * `supabase start`, `docker compose up -d redis dev-mysql dev-mongo
 * dev-postgres connector-mysql connector-mongodb connector-supabase`,
 * apps/worker/.env's SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY.
 *
 * Note: @nia/schemas is consumed from its built dist/ (package.json's
 * main/exports point there) — rebuild it (`pnpm --filter @nia/schemas
 * build`) after editing packages/schemas/src before rerunning this script.
 */
import {
  compilePushdown,
  compileFailurePreChecks,
  applyResidualTransforms,
  parseExpression,
  OnFailureAbortError,
  type TransformConfig,
  type SourceDialect,
  type StepFailureReport,
} from "@nia/schemas";
import {
  provisionMysqlFixture,
  provisionPostgresFixture,
  provisionMongoFixture,
  runCompiledQuery,
  runPagedAggregateQuery,
  runFailurePreCheck,
  diffRows,
  parseDateShapedString,
  type ProvisionedFixture,
} from "./lib/dbHarness.js";
import { AGREEMENT_CASES, type AgreementCase } from "./lib/agreementCases.js";

const DIALECTS: SourceDialect[] = ["mysql", "postgres", "mongo"];
const ARMS = [...DIALECTS, "residual"] as const;
type Arm = (typeof ARMS)[number];

function log(msg: string): void {
  console.log(msg);
}

async function provisionFor(
  dialect: SourceDialect,
  seedRows: Record<string, unknown>[],
  dateColumns: readonly string[] = [],
  decimalColumns: readonly string[] = [],
): Promise<ProvisionedFixture> {
  if (dialect === "mysql") return provisionMysqlFixture(seedRows, dateColumns, decimalColumns);
  if (dialect === "postgres") return provisionPostgresFixture(seedRows, dateColumns, decimalColumns);
  return provisionMongoFixture(seedRows, dateColumns);
}

function buildConfig(testCase: AgreementCase): TransformConfig {
  if (testCase.steps) return { steps: testCase.steps };
  const parsed = parseExpression(testCase.filterExpr);
  if (!parsed.ok) throw new Error(`agreement case filterExpr failed to parse: ${parsed.error}`);
  return { steps: [{ kind: "filter", expr: parsed.expr }] };
}

function inferColumnOrder(seedRows: Record<string, unknown>[]): string[] {
  const cols = new Set<string>();
  for (const row of seedRows) for (const k of Object.keys(row)) cols.add(k);
  return [...cols];
}

/**
 * Pre-batch-5 hardening (mongo date-literal coercion review): filtering
 * runs on the ORIGINAL seed strings, unmodified — residual's own
 * comparison logic treats a date-shaped seed value as a plain string,
 * which is why it already selects the correct rows for a `dateColumns`
 * case with no changes needed here. Only the RETURNED rows get a
 * dateColumns field normalized to `new Date(v).toISOString()`, after
 * filtering, purely so the comparison against the 3 real pushdown arms
 * is apples-to-apples: mysql/postgres/mongo's real DATE/DATETIME/BSON
 * Date columns round-trip through dispatch() as a full ISO instant
 * (verified live: "2024-01-15" seeded -> "2024-01-15T00:00:00.000Z"
 * returned), while residual has no DB column type to normalize through
 * and would otherwise just echo the raw seed string back, producing a
 * spurious format-only DIVERGE against all 3 real arms simultaneously —
 * not a real behavioral disagreement (verified live: mysql/postgres/
 * mongo already agree with EACH OTHER on both row count and content for
 * every dateColumns case; only residual's raw-string echo differed).
 *
 * Batch 5 fix: this MUST go through `parseDateShapedString`, not a bare
 * `new Date(v)` — a bare-string datetime with no zone suffix (this file's
 * "datetime" DateShape, e.g. "2024-03-07T15:42:33") parses as LOCAL time
 * per the JS Date spec, silently pulling the harness process's own OS
 * timezone into what's supposed to be a UTC-pinned comparison value. Caught
 * live as an exact -5:30 offset on a non-UTC (IST) dev machine — see
 * dbHarness.ts's parseDateShapedString doc comment for the full story.
 */
function runResidual(
  testCase: AgreementCase,
  config: TransformConfig,
): { rows: Record<string, unknown>[]; failures: StepFailureReport[] } {
  const cols = inferColumnOrder(testCase.seedRows);
  const rows = testCase.seedRows.map((row) => cols.map((c) => row[c] ?? null));
  const result = applyResidualTransforms(cols, rows, config.steps);
  const dateCols = new Set(testCase.dateColumns ?? []);
  const mapped = result.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    result.columns.forEach((c, i) => {
      const v = row[i];
      obj[c] = dateCols.has(c) && typeof v === "string" ? parseDateShapedString(v).toISOString() : v;
    });
    return obj;
  });
  return { rows: mapped, failures: result.failures ?? [] };
}

/**
 * Phase 8b-3: `--tag=<tag>` narrows the run to only cases carrying that
 * `AgreementCase.tag` (e.g. `--tag=onfailure`) — the "simple filter flag"
 * Step 3 calls for so the new onFailure cases can be run/iterated on
 * without re-running the full ~40-case suite against live sandbox DBs
 * every time.
 */
function selectCases(): AgreementCase[] {
  const tagArg = process.argv.find((a) => a.startsWith("--tag="));
  if (!tagArg) return AGREEMENT_CASES;
  const tag = tagArg.slice("--tag=".length);
  return AGREEMENT_CASES.filter((c) => c.tag === tag);
}

async function main(): Promise<void> {
  const cases = selectCases();
  log(`=== ops-agreement: ${cases.length} case(s), 4-way (mysql/postgres/mongo pushdown + residual) ===\n`);
  const cleanups: Array<() => Promise<void>> = [];
  let totalDivergentCases = 0;
  let totalErroredCases = 0;
  let totalUntriagedCases = 0;

  for (const testCase of cases) {
    log(`--- ${testCase.description} ---`);
    if (testCase.steps) {
      log(`    steps: ${testCase.steps.map((s) => s.kind).join(" -> ")} (filterExpr field unused for this case: ${testCase.filterExpr})`);
    } else {
      log(`    filter: ${testCase.filterExpr}`);
    }
    const config = buildConfig(testCase);
    const results: Partial<Record<Arm, Record<string, unknown>[]>> = {};
    const erroredArms: Arm[] = [];

    let pushedCountAssertionFailed = false;
    for (const dialect of DIALECTS) {
      try {
        const provisioned = await provisionFor(dialect, testCase.seedRows, testCase.dateColumns, testCase.decimalColumns);
        cleanups.push(provisioned.cleanup);
        const plan = compilePushdown(dialect, config);
        if (testCase.expectedPushedResidualCount !== undefined) {
          if (plan.residualCount === testCase.expectedPushedResidualCount) {
            log(`    PASS  ${dialect}: residualCount matches expected (${plan.residualCount})`);
          } else {
            log(
              `    FAIL  ${dialect}: expected residualCount ${testCase.expectedPushedResidualCount}, got ${plan.residualCount}`,
            );
            pushedCountAssertionFailed = true;
          }
        }
        if (plan.residualCount > 0) {
          log(`    WARN  ${dialect}: filter not fully pushed down (${plan.residualCount} residual step(s)) — skipping this arm`);
          continue;
        }
        results[dialect] = testCase.pageSize
          ? await runPagedAggregateQuery(dialect, provisioned, config, testCase.pageSize)
          : await runCompiledQuery(dialect, provisioned, plan.dialectQuery);

        if (testCase.expectedPreCheckFailures) {
          // Phase 9 Part 4: live-proves compileFailurePreChecks + the
          // buildFailurePreCheckQuery/dispatch pair runEtl.ts calls before
          // extraction produce the correct failure count on a real DB —
          // independent of (and never merged with) the row-diff above.
          const checks = compileFailurePreChecks(dialect, config);
          const actual = await Promise.all(
            checks.map(async (check) => ({
              label: check.label,
              fns: check.fns,
              count: await runFailurePreCheck(dialect, provisioned, check.dialectQuery),
            })),
          );
          if (JSON.stringify(actual) === JSON.stringify(testCase.expectedPreCheckFailures)) {
            log(`    PASS  ${dialect}: pushed pre-check counts match: ${JSON.stringify(actual)}`);
          } else {
            log(
              `    FAIL  ${dialect}: pushed pre-check counts mismatch — expected ${JSON.stringify(testCase.expectedPreCheckFailures)}, got ${JSON.stringify(actual)}`,
            );
            pushedCountAssertionFailed = true;
          }
        }
      } catch (err) {
        log(`    ERROR  ${dialect}: ${err instanceof Error ? err.message : String(err)}`);
        erroredArms.push(dialect);
      }
    }
    let abortAssertionFailed = pushedCountAssertionFailed;
    if (testCase.expectAbort) {
      // Phase 8b-3: a "fail" case is expected to ABORT the residual arm
      // (OnFailureAbortError), never to return rows — assert that instead
      // of the normal diff/failures-count path below.
      try {
        runResidual(testCase, config);
        log(`    FAIL  expected residual to throw OnFailureAbortError containing "${testCase.expectAbort}", but it returned rows`);
        abortAssertionFailed = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof OnFailureAbortError && message.includes(testCase.expectAbort)) {
          log(`    PASS  residual aborted as expected: ${message}`);
        } else {
          log(`    FAIL  expected OnFailureAbortError containing "${testCase.expectAbort}", got: ${message}`);
          abortAssertionFailed = true;
        }
      }
    } else {
      try {
        const residual = runResidual(testCase, config);
        results.residual = residual.rows;
        if (testCase.expectedResidualFailures) {
          // Only the residual arm ever produces a per-step failure count
          // (see onFailure.ts's top doc comment) — a pushed "null"/"drop"
          // arm has nothing to compare this against.
          const actual = residual.failures.map((f) => ({ label: f.label, fns: f.fns, count: f.count }));
          const expected = testCase.expectedResidualFailures;
          if (JSON.stringify(actual) === JSON.stringify(expected)) {
            log(`    PASS  residual failures match: ${JSON.stringify(actual)}`);
          } else {
            log(`    FAIL  residual failures mismatch — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
            abortAssertionFailed = true;
          }
        }
      } catch (err) {
        log(`    ERROR  residual: ${err instanceof Error ? err.message : String(err)}`);
        erroredArms.push("residual");
      }
    }

    const arms = ARMS.filter((a) => results[a] !== undefined);
    let caseDivergent = false;
    for (let i = 0; i < arms.length; i++) {
      for (let j = i + 1; j < arms.length; j++) {
        const a = arms[i]!;
        const b = arms[j]!;
        const mismatches = diffRows(`${a} vs ${b}`, results[a]!, results[b]!);
        if (mismatches.length > 0) {
          caseDivergent = true;
          for (const m of mismatches) log(`    DIVERGE  ${m}`);
        }
      }
    }
    const isUntriaged = (caseDivergent || erroredArms.length > 0 || abortAssertionFailed) && !testCase.expectedDivergence;
    if (caseDivergent) totalDivergentCases++;
    if (erroredArms.length > 0) totalErroredCases++;
    if (isUntriaged) totalUntriagedCases++;

    if (testCase.expectedDivergence) {
      if (caseDivergent || erroredArms.length > 0) {
        log(`    XFAIL  known divergence — ${testCase.expectedDivergence.reason}`);
        log(`           (${testCase.expectedDivergence.decisionsRef})`);
      } else {
        log(`    XPASS  marked expectedDivergence but all arms agreed with no errors — remove the marker: ${testCase.expectedDivergence.decisionsRef}`);
      }
    } else if (!caseDivergent && erroredArms.length === 0) {
      log("    AGREE  all evaluated arms match");
    } else if (!caseDivergent) {
      log(`    AGREE (partial)  evaluated arms match; ${erroredArms.join(", ")} errored — see ERROR line(s) above`);
    }
    log("");
  }

  log("=== cleanup ===");
  for (const cleanup of cleanups) {
    await cleanup().catch((err) => log(`  cleanup warning: ${err instanceof Error ? err.message : String(err)}`));
  }

  log(
    `\n${
      totalUntriagedCases === 0
        ? `ALL CASES AGREE (OR ARE DECLARED XFAIL), NO UNTRIAGED ERRORS${
            totalDivergentCases > 0 || totalErroredCases > 0
              ? ` — ${totalDivergentCases}/${cases.length} case(s) diverged, ${totalErroredCases}/${cases.length} case(s) had an errored arm, all covered by an expectedDivergence marker (see XFAIL line(s) above)`
              : ""
          }`
        : `${totalUntriagedCases}/${cases.length} case(s) had an UNTRIAGED divergence, error, or failed assertion (${totalDivergentCases} diverged, ${totalErroredCases} had an errored arm total) — review report above, triage each per the plan (homogenize only if a genuine bug, else declare via expectedDivergence + docs/decisions.md)`
    }`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
