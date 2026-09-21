/**
 * Phase 8b-2a, Deliverable 3 — per-expression semantic-agreement cases.
 * Updated Phase 8b-2b: all 8 divergences originally found here were fixed
 * (see docs/decisions.md's "Phase 8b-2b: Semantics homogenization" entry),
 * not declared — this file's cases now assert *agreement*, not documented
 * disagreement. New cases were added for the exact semantics Phase 8b-2b
 * pinned down: three-valued and/or/not, is_number/is_text vs the new
 * looks_numeric, contains with and without the caseInsensitive flag, and
 * unary minus (the grammar gained a real `-` prefix production in Fix 5).
 *
 * Kept separate from `OP_FIXTURES` (packages/schemas/src/ops/
 * __conformance__/fixtures.ts) deliberately: those are per-op
 * pushdown-*shape* fixtures (one config -> one expected compiled query),
 * a different axis from these per-expression cross-evaluator *semantic*
 * cases (one filter expr -> run through 4 independent evaluators, diffed
 * pairwise). Forcing these into OpFixture's shape would be the same
 * fixture-duplication anti-pattern Deliverable 2's `dbCase` addition was
 * built to avoid, just inverted.
 *
 * Each case is run by ops-agreement.ts through:
 *   - mysql pushdown    (compilePushdown("mysql", ...) -> real dispatch)
 *   - postgres pushdown (compilePushdown("postgres", ...) -> real dispatch)
 *   - mongo pushdown    (compilePushdown("mongo", ...) -> real dispatch)
 *   - residual          (applyResidualTransforms, in-process, no DB)
 * against the SAME seedRows, then diffed pairwise (6 pairs). As of Phase
 * 8b-2b every case below is expected to agree across all 4 evaluators —
 * per the standing principle in docs/decisions.md, a persistent mismatch
 * here means either a real bug (fix it) or a genuinely-impossible-
 * compliance case (declare it explicitly in docs/decisions.md, don't
 * leave it as a silent red case).
 *
 * `age > -1` (the literal form residualEval.ts's own header once used to
 * illustrate the NULL-coercion bug) now parses and runs directly — Fix 5
 * added unary minus to the grammar, folding a literal operand straight to
 * a negative literal (`-1` -> `{kind:"literal", value:-1}`), so this no
 * longer needs the `age >= 0` workaround the pre-8b-2b version of this
 * file used. A separate case below (`unaryCases`) exercises the
 * non-literal-operand desugaring path (`-field` -> `0 - field`) that Fix 5
 * also introduced, since that's a different code path than the literal
 * fold and both need live coverage.
 */

import { parseExpression, type TransformStep, type Expr } from "@nia/schemas";

export interface AgreementCase {
  description: string;
  seedRows: Record<string, unknown>[];
  /**
   * Parsed via parseExpression, wrapped in a single `{kind:"filter", expr}`
   * step — the ordinary single-step case. Ignored when `steps` (below) is
   * set; still required by the type since every case up to now uses this
   * form and `steps` is the rare exception, not a replacement for it.
   */
  filterExpr: string;
  /**
   * Condition-3 escape hatch (Follow-up 1, arg(n)-desync hardening): an
   * explicit, ordered multi-step `TransformConfig.steps` array, used
   * verbatim INSTEAD of the single-step `filterExpr` wrap when present.
   * Needed because `filterExpr` can only ever express one `filter` step —
   * it cannot represent a case whose whole point is a SPECIFIC cross-step
   * ordering (e.g. a `filter` step before a `computed_field` step, each
   * with its own literal, to prove params stay bound to the right
   * placeholder once compileSql's per-step emission is combined into one
   * shared params array — see docs/decisions.md's Phase 8b-2 Follow-up 1
   * entry for the full mysql-scan-order-vs-push-order story this exists
   * to regression-guard).
   */
  steps?: TransformStep[];
  /**
   * Item 1 (pre-batch-5 hardening) — opt-in list of seedRows keys that
   * should be provisioned as real DATE/DATETIME (mysql), date/timestamp/
   * timestamptz (postgres), or BSON Date (mongo) columns instead of the
   * default text/VARCHAR/string column dbHarness.ts would otherwise infer
   * for a string value. Deliberately opt-in, not auto-detected from shape
   * — see dbHarness.ts's inferSqlType doc for why (auto-detection broke
   * the pre-existing to_date() cases below, which need `x` to stay a
   * plain string).
   */
  dateColumns?: string[];
  /**
   * Fix (numeric group keys under MySQL pagination) — opt-in list of
   * seedRows keys that should be provisioned as a real DECIMAL(10,2)
   * (mysql) / numeric(10,2) (postgres) column instead of the default
   * DOUBLE/double precision dbHarness.ts would otherwise infer for a
   * numeric value. Needed to genuinely exercise the driver-level rendering
   * distinction the fix's cursor-column change is proving is now handled
   * (mysql2 returns DECIMAL columns as JS strings, e.g. "10.00", but
   * DOUBLE columns as JS numbers) — see dbHarness.ts's inferSqlType doc
   * comment.
   */
  decimalColumns?: string[];
  /**
   * Item 1 (pre-batch-5 hardening) — marks this case as a KNOWN, DECLARED
   * divergence/error rather than an untriaged one, mirroring
   * `OpFixture.knownFailure` (packages/schemas/src/ops/__conformance__/
   * fixtures.ts) one axis over. `ops-agreement.ts` reports it as XFAIL
   * (still diverging/erroring, doesn't count toward the run's "not all
   * agree" banner) or XPASS (unexpectedly started fully agreeing —
   * informational only, still doesn't fail the run) — a genuinely NEW
   * divergence on any OTHER case still fails the run immediately.
   *
   * Different category from a case that's correctly left red (e.g. a real
   * bug awaiting a fix, like the historical "quotient" divergence): this
   * marker is only for a divergence that is a declared, permanent design
   * consequence, not a bug — see `decisionsRef`. Keep this list short.
   */
  expectedDivergence?: { reason: string; decisionsRef: string };
  /**
   * Phase 8b-3 — optional grouping tag consumed by ops-agreement.ts's
   * `--tag=<tag>` CLI flag, which runs only cases carrying that tag instead
   * of the full suite. Added per the plan's "add a filter flag to
   * ops-agreement.ts if needed to run only new cases" instruction.
   */
  tag?: string;
  /**
   * Phase 8b-3 — for an onFailure: "null" | "drop" case: asserts the
   * residual arm's `failures` report (ops/types.ts's StepFailureReport[])
   * instead of just diffing rows. Pushdown arms don't produce a failure
   * count in v1 (see onFailure.ts's top doc comment) — only the residual
   * arm is checked against this; all evaluated arms are still row-diffed
   * as normal.
   */
  expectedResidualFailures?: { label: string; fns: string[]; count: number }[];
  /**
   * Phase 8b-3 — for an onFailure: "fail" case: asserts the residual arm
   * throws OnFailureAbortError with a message containing this substring
   * (residual's in-process semantics are unaffected by pushability).
   * Originally (Phase 8b-3) this always meant every SQL/mongo pushdown arm
   * WARN-skipped too (fallibleStepIsPushable forced every "fail" case
   * fully residual). Phase 9 Part 4 changed that: only "quarantine" still
   * forces residual, so a "fail" case now typically also carries
   * `expectedPushedResidualCount: 0` and `expectedPreCheckFailures` — the
   * pushdown arms stay pushed, run normally, and get row-diffed like any
   * other case, while this field only ever asserts the residual arm's
   * abort behavior.
   */
  expectAbort?: string;
  /**
   * Phase 8b-3 follow-up (item 3) — pins `compilePushdown`'s
   * `plan.residualCount` for every dialect arm, so a case can assert
   * whether a composition stays fully pushed (0) or falls to residual (>0)
   * — independent of `expectedResidualFailures`, which only ever inspects
   * the pure in-process reference arm. Used to lock in the documented v1
   * trade-off that a fully-pushed "null"/"drop" composition (e.g. a
   * fallible filter immediately before a pushed aggregate) produces NO
   * failure count in a real run (runEtl.ts only ever computes `failures`
   * for `residualSteps`, which is empty when everything pushes) — verified
   * live via `compilePushdown` directly: "drop" stays fully pushed
   * (residualCount 0 on all 3 dialects) while "fail" forces the entire
   * filter+aggregate pair residual (residualCount 2), which is what lets
   * the residual arm's OnFailureAbortError correctly abort with an
   * accurate count. See docs/decisions.md's 8b-3 entry for the full
   * writeup of why this is NOT treated as a bug to fix.
   */
  expectedPushedResidualCount?: number;
  /**
   * Phase 9 Part 4 — for a case whose fallible step now stays PUSHED
   * (paired with `expectedPushedResidualCount: 0`): asserts the live
   * failure count `pushdown.ts`'s `compileFailurePreChecks` produces for
   * each pushed dialect, run via `buildFailurePreCheckQuery` +
   * `dispatch()` (the exact pair `runEtl.ts` calls before extraction).
   * Proves the pre-check mechanism itself reports the correct count on a
   * real DB — for policy "fail" this is the count that drives a real
   * run's abort-before-any-write; for "null"/"drop" it's the count a real
   * run reports in its "done" event, replacing the old v1 gap.
   */
  expectedPreCheckFailures?: { label: string; fns: string[]; count: number }[];
  /**
   * Phase 9 Part 4 test list — when set, ops-agreement.ts runs every pushed
   * SQL/Mongo arm through `dbHarness.ts`'s `runPagedAggregateQuery` (a real
   * multi-page loop threading `SqlGroupKeyCursor`, mirroring runEtl.ts's own
   * per-chunk resume logic) instead of the ordinary single-shot
   * `runCompiledQuery`, using this value as the page size. The residual arm
   * is unaffected (it has no pagination concept — `applyResidualTransforms`
   * always sees the whole dataset in one call) and still serves as the
   * ground-truth group set every paginated pushdown arm's diffRows result
   * is compared against. Only meaningful for a case whose `steps` contain
   * exactly one `aggregate` step that stays fully pushed
   * (`expectedPushedResidualCount: 0`) — `runPagedAggregateQuery` itself
   * throws if that's not true.
   */
  pageSize?: number;
}

/** Parses a bare expression string for use inside a hand-built `steps` array (see `AgreementCase.steps`'s doc comment above) — throws at module load if the string doesn't parse, matching ops-agreement.ts's own buildConfig behavior for the ordinary filterExpr path. */
function parseExpr(exprString: string): Expr {
  const parsed = parseExpression(exprString);
  if (!parsed.ok) throw new Error(`agreementCases.ts: failed to parse expression "${exprString}": ${parsed.error}`);
  return parsed.expr;
}

export const AGREEMENT_CASES: AgreementCase[] = [
  {
    description: "comparison against NULL — age > -1 (Fix 1: three-valued NULL logic; also exercises Fix 5's literal unary-minus fold)",
    seedRows: [
      { age: 10, name: "A" },
      { age: null, name: "B" },
      { age: -5, name: "C" },
    ],
    filterExpr: "age > -1",
  },
  {
    description: 'logical AND with a NULL-comparison operand — age > -1 and name = "Ada" (Fix 1: SQL AND truth table, false dominates)',
    seedRows: [
      { age: null, name: "Ada" },
      { age: 10, name: "Ada" },
      { age: 10, name: "Bob" },
    ],
    filterExpr: 'age > -1 and name = "Ada"',
  },
  {
    description: 'logical OR with a NULL-comparison operand — age > -1 or name = "Bob" (Fix 1: SQL OR truth table, true dominates)',
    seedRows: [
      { age: null, name: "Zzz" },
      { age: 10, name: "Zzz" },
    ],
    filterExpr: 'age > -1 or name = "Bob"',
  },
  {
    description: "logical NOT with a NULL-comparison operand — not (age > -1) (Fix 1 residual + Fix 2 mongo: NOT NULL = NULL)",
    seedRows: [{ age: null, name: "X" }],
    filterExpr: "not (age > -1)",
  },
  {
    description: 'conditional whose predicate evaluates NULL — if(age > -1, "big", "small") = "big"',
    seedRows: [{ age: null }, { age: 10 }, { age: -5 }],
    filterExpr: 'if(age > -1, "big", "small") = "big"',
  },
  {
    description: "is_null(age) against a NULL row and non-NULL rows",
    seedRows: [{ age: null }, { age: 5 }, { age: 0 }],
    filterExpr: "is_null(age)",
  },
  {
    description: "is_not_null(age) against a NULL row and non-NULL rows",
    seedRows: [{ age: null }, { age: 5 }, { age: 0 }],
    filterExpr: "is_not_null(age)",
  },
  {
    description: "is_number(name) against a numeric-looking string column — Fix 3: true-type check everywhere, so a VARCHAR/string '123' is NOT is_number on any evaluator",
    seedRows: [{ name: "Ada" }, { name: "123" }, { name: null }],
    filterExpr: "is_number(name)",
  },
  {
    description: "is_text(name) against a numeric-looking string column — Fix 3: true-type check everywhere, so a VARCHAR/string '123' IS is_text on every evaluator",
    seedRows: [{ name: "Ada" }, { name: "123" }, { name: null }],
    filterExpr: "is_text(name)",
  },
  {
    description: "looks_numeric(name) against the same numeric-looking string column — Fix 3: content-based check, '123' matches on every evaluator (the pre-8b-2b is_number behavior, now under its own name)",
    seedRows: [{ name: "Ada" }, { name: "123" }, { name: null }],
    filterExpr: "looks_numeric(name)",
  },
  {
    description: 'contains(name, "A") default (case-SENSITIVE) — Fix 4: mysql LIKE BINARY, postgres LIKE, mongo no "i" option, residual .includes() all agree only "Ada" matches, not "ada"',
    seedRows: [{ name: "Ada" }, { name: "ada" }, { name: "Bob" }],
    filterExpr: 'contains(name, "A")',
  },
  {
    description: 'contains(name, "A", true) explicit case-INSENSITIVE flag — Fix 4: mysql LOWER()/LOWER(), postgres ILIKE, mongo "i" option, residual .toLowerCase() all agree both "Ada" and "ada" match',
    seedRows: [{ name: "Ada" }, { name: "ada" }, { name: "Bob" }],
    filterExpr: 'contains(name, "A", true)',
  },
  {
    description: 'contains(name, "d") against a NULL row — null-safety check for the mongo $regexMatch pushdown path specifically',
    seedRows: [{ name: "Ada" }, { name: null }],
    filterExpr: 'contains(name, "d")',
  },
  {
    description: "unary minus, non-literal-operand desugaring path — age > -age2 (Fix 5: '-age2' desugars to the binary node '0 - age2', a different code path than a literal '-1' fold)",
    seedRows: [
      { age: 10, age2: -20 },
      { age: 10, age2: 20 },
      { age: null, age2: 5 },
    ],
    filterExpr: "age > -age2",
  },
  {
    description: "baseline sanity — age > 5 against NULL-free data, all 4 evaluators expected to agree",
    seedRows: [{ age: 2 }, { age: 5 }, { age: 8 }, { age: 10 }],
    filterExpr: "age > 5",
  },
  // Phase 8b-2, batch 0 — mysql string-comparison collation (see
  // docs/decisions.md's "Phase 8b-2, batch 0" entry). Mixed-case,
  // single-char seed data chosen so ASCII/byte ordering and a
  // case-insensitive/dictionary ordering provably diverge on the ordering
  // operators too, not just equality — matches collation-probe.ts's seed
  // exactly. Before Fix 1/2, mysql matched extra/wrong rows on every one
  // of these 6 (case-insensitive default collation), and residual's
  // gt/gte/lt/lte matched nothing at all (Number("a") === NaN). All 6
  // expected to agree 4-way now.
  {
    description: 'v = "b" — Fix 1: mysql forces BINARY, no longer matches "B" via case-insensitive collation',
    seedRows: [{ v: "a" }, { v: "A" }, { v: "B" }, { v: "z" }, { v: "Z" }, { v: "b" }],
    filterExpr: 'v = "b"',
  },
  {
    description: 'v != "b" — Fix 1: paired with eq so NOT(v="b") stays the exact complement, not independently wrong',
    seedRows: [{ v: "a" }, { v: "A" }, { v: "B" }, { v: "z" }, { v: "Z" }, { v: "b" }],
    filterExpr: 'v != "b"',
  },
  {
    description: 'v > "B" — Fix 2: mysql BINARY-forced ordering; residual compareOrdered() lexicographic string path (was Number("a")=NaN, always false)',
    seedRows: [{ v: "a" }, { v: "A" }, { v: "B" }, { v: "z" }, { v: "Z" }, { v: "b" }],
    filterExpr: 'v > "B"',
  },
  {
    description: 'v >= "B" — Fix 2, same as gt plus the boundary-equal row',
    seedRows: [{ v: "a" }, { v: "A" }, { v: "B" }, { v: "z" }, { v: "Z" }, { v: "b" }],
    filterExpr: 'v >= "B"',
  },
  {
    description: 'v < "B" — Fix 2, ordering below the boundary',
    seedRows: [{ v: "a" }, { v: "A" }, { v: "B" }, { v: "z" }, { v: "Z" }, { v: "b" }],
    filterExpr: 'v < "B"',
  },
  {
    description: 'v <= "B" — Fix 2, ordering below the boundary plus the boundary-equal row',
    seedRows: [{ v: "a" }, { v: "A" }, { v: "B" }, { v: "z" }, { v: "Z" }, { v: "b" }],
    filterExpr: 'v <= "B"',
  },
  // Phase 8b-2, batch 1 — DAX-derived Math core (see docs/decisions.md's
  // batch 1 entry). Every function below gets at least one NULL-operand
  // row; divide/round_to_multiple additionally get a case combining a
  // NULL operand with a zero divisor/multiple, since that specific
  // combination is exactly where a real cross-evaluator bug was found and
  // fixed while writing these cases (sqlShared.ts/mongo.ts's zero-branch
  // originally ignored a NULL other-operand — see their case bodies).
  {
    description: "abs(delta) — NULL-safe, negative and zero operands",
    seedRows: [{ delta: -5 }, { delta: 5 }, { delta: 0 }, { delta: null }],
    filterExpr: "abs(delta) = 5",
  },
  {
    description: "ceil(price) — rounds up to the next integer, NULL-safe",
    seedRows: [{ price: 9.1 }, { price: 10.0 }, { price: 8.5 }, { price: null }],
    filterExpr: "ceil(price) = 10",
  },
  {
    description: "floor(price) — rounds down to the next integer, NULL-safe",
    seedRows: [{ price: 9.9 }, { price: 9.0 }, { price: 10.1 }, { price: null }],
    filterExpr: "floor(price) = 9",
  },
  {
    description: "sign(delta) — negative/positive/zero, NULL-safe",
    seedRows: [{ delta: -5 }, { delta: 5 }, { delta: 0 }, { delta: null }],
    filterExpr: "sign(delta) = -1",
  },
  {
    description: "sqrt(x) of a perfect square, NULL-safe",
    seedRows: [{ x: 9 }, { x: 16 }, { x: null }],
    filterExpr: "sqrt(x) = 3",
  },
  {
    description: "is_null(sqrt(x)) — negative input and a NULL input both yield NULL (postgres/mongo's native sqrt would otherwise error on negative)",
    seedRows: [{ x: -4 }, { x: null }, { x: 9 }],
    filterExpr: "is_null(sqrt(x))",
  },
  {
    description: "trunc(x) truncates toward zero for a negative non-integer — distinct from int()/floor() below, NULL-safe",
    seedRows: [{ x: -2.5 }, { x: 2.5 }, { x: null }],
    filterExpr: "trunc(x) = -2",
  },
  {
    description: "int(x) floors toward -infinity for a negative non-integer — same value as trunc(x) above except this row, proving int != trunc, NULL-safe",
    seedRows: [{ x: -2.5 }, { x: 2.5 }, { x: null }],
    filterExpr: "int(x) = -3",
  },
  {
    description: "power(base, exp), NULL-safe",
    seedRows: [{ base: 2, exp: 3 }, { base: 3, exp: 2 }, { base: null, exp: 2 }],
    filterExpr: "power(base, exp) = 8",
  },
  {
    description: "quotient(n, d) truncates toward zero (Excel QUOTIENT, not floor), NULL-safe",
    seedRows: [{ n: 7, d: 3 }, { n: -7, d: 3 }, { n: null, d: 3 }],
    filterExpr: "quotient(n, d) = 2",
  },
  {
    description: "is_null(quotient(n, d)) — zero divisor and NULL numerator both yield NULL",
    seedRows: [{ n: 6, d: 0 }, { n: null, d: 3 }, { n: 7, d: 3 }],
    filterExpr: "is_null(quotient(n, d))",
  },
  {
    description: "mod(n, d) takes the SIGN OF THE DIVISOR (DAX/Excel convention, not mysql/postgres native MOD's dividend-sign) — positive divisor case, NULL-safe",
    seedRows: [{ n: -7, d: 3 }, { n: 7, d: 3 }, { n: null, d: 3 }],
    filterExpr: "mod(n, d) = 2",
  },
  {
    description: "mod(n, d) sign-of-divisor — negative divisor case, NULL-safe",
    seedRows: [{ n: 7, d: -3 }, { n: -7, d: -3 }, { n: null, d: -3 }],
    filterExpr: "mod(n, d) = -2",
  },
  {
    description: "is_null(mod(n, d)) — zero divisor and NULL numerator both yield NULL",
    seedRows: [{ n: 6, d: 0 }, { n: null, d: 3 }, { n: 7, d: 3 }],
    filterExpr: "is_null(mod(n, d))",
  },
  {
    description: "divide(n, d) with no default — zero denominator yields NULL, not an error (postgres's native `/` would throw), NULL-numerator-safe",
    seedRows: [{ n: 10, d: 5 }, { n: 10, d: 0 }, { n: null, d: 5 }],
    filterExpr: "divide(n, d) = 2",
  },
  {
    description: 'divide(n, d, 0) with an explicit default — zero denominator yields the default, live-verifies the fix where the CASE\'s zero-branch was returning the fallback even when n was NULL (should NOT match here since n is NULL, not just d=0)',
    seedRows: [{ n: 10, d: 0 }, { n: null, d: 0 }, { n: 10, d: 5 }],
    filterExpr: "divide(n, d, 0) = 0",
  },
  {
    description: "is_null(divide(n, d, 0)) — NULL numerator wins over the default even when d is also 0 (the exact bug found+fixed while writing this case)",
    seedRows: [{ n: null, d: 0 }, { n: 10, d: 0 }, { n: 10, d: 5 }],
    filterExpr: "is_null(divide(n, d, 0))",
  },
  {
    description: "round(x) default digits=0, half-away-from-zero at the exact .5 boundary (homogenized by construction — mongo's native $round would banker's-round this differently), NULL-safe",
    seedRows: [{ price: 3.5 }, { price: 3.4 }, { price: null }],
    filterExpr: "round(price) = 4",
  },
  {
    description: "round(x, 2) with explicit digits, half-away-from-zero at the exact .125 boundary",
    seedRows: [{ x: 1.125 }, { x: 1.12 }, { x: null }],
    filterExpr: "round(x, 2) = 1.13",
  },
  {
    description: "round(x, 2) negative operand — sign preserved through the SIGN()*FLOOR(...)/scale construction",
    seedRows: [{ x: -1.125 }, { x: -1.12 }],
    filterExpr: "round(x, 2) = -1.13",
  },
  {
    description: "round_down(x, 2) truncates toward zero at the exact .125 boundary (never rounds away from zero, unlike round())",
    seedRows: [{ x: 1.125 }, { x: 1.13 }],
    filterExpr: "round_down(x, 2) = 1.12",
  },
  {
    description: "round_up(x, 2) rounds away from zero at the exact .125 boundary (never truncates, unlike round_down())",
    seedRows: [{ x: 1.125 }, { x: 1.12 }],
    filterExpr: "round_up(x, 2) = 1.13",
  },
  {
    description: "round_to_multiple(x, m) (MROUND) — normal case, NULL-safe",
    seedRows: [{ x: 5, m: 3 }, { x: 4, m: 3 }, { x: null, m: 3 }],
    filterExpr: "round_to_multiple(x, m) = 6",
  },
  {
    description: "round_to_multiple(x, 0) — Excel/DAX MROUND(x,0)=0 convention regardless of x",
    seedRows: [{ x: 5, m: 0 }, { x: -5, m: 0 }, { x: 0, m: 0 }],
    filterExpr: "round_to_multiple(x, m) = 0",
  },
  {
    description: "is_null(round_to_multiple(x, m)) — NULL x wins over the multiple=0 branch even when m is also 0 (the same class of bug found+fixed in divide above, fixed identically here)",
    seedRows: [{ x: null, m: 0 }, { x: 5, m: 0 }, { x: 5, m: 3 }],
    filterExpr: "is_null(round_to_multiple(x, m))",
  },
  // Phase 8b-2, batch 2 — Math remainder: exp|ln|log (see docs/
  // decisions.md's batch 2 entry). Cases deliberately use inputs whose
  // expected result is an exact value representable identically in
  // floating point on every engine (exp(0)=1, ln(1)=0, log base-2 of a
  // power of 2) rather than an irrational result like exp(1)/ln(10),
  // since a `= <value>` filter comparison would otherwise risk a false
  // divergence report from ordinary cross-engine floating-point rounding
  // noise, not a real semantic bug. Every fn also gets an is_null(...)
  // case proving the pinned zero/negative-input NULL contract (postgres's
  // native ln()/log() and mongo's native $ln/$log both THROW on those
  // inputs rather than nulling the row — verified live against this
  // project's own sandbox — so this is the one place all 4 evaluators
  // provably diverge from "just call the native primitive" and agree
  // only because of the explicit guard in each evaluator).
  {
    description: "exp(x) at x=0 (exact: e^0=1 on every engine), NULL-safe",
    seedRows: [{ x: 0 }, { x: 1 }, { x: null }],
    filterExpr: "exp(x) = 1",
  },
  {
    description: "ln(x) at x=1 (exact: ln(1)=0 on every engine), NULL-safe",
    seedRows: [{ x: 1 }, { x: 10 }, { x: null }],
    filterExpr: "ln(x) = 0",
  },
  {
    description: "is_null(ln(x)) — zero and negative input both yield NULL (postgres's native ln()/mongo's native $ln would otherwise throw a runtime error instead of nulling the row)",
    seedRows: [{ x: -4 }, { x: 0 }, { x: null }, { x: 9 }],
    filterExpr: "is_null(ln(x))",
  },
  {
    description: "log(x) with base omitted — same contract/value as ln(x), not postgres's own base-10 single-arg log(x) default",
    seedRows: [{ x: 1 }, { x: 10 }, { x: null }],
    filterExpr: "log(x) = 0",
  },
  {
    description: "log(x, base) with an explicit base — log base 2 of 8 = 3 exactly (power-of-2 operands, exact in floating point on every engine); base argument order is swapped internally for mysql/postgres's native LOG(base,x) but not for mongo's native $log:[x,base] — this case exercises both emission paths producing the same grammar-level result",
    seedRows: [{ x: 8, base: 2 }, { x: 9, base: 3 }, { x: null, base: 2 }],
    filterExpr: "log(x, base) = 3",
  },
  {
    description: "is_null(log(x, base)) — x<=0, base<=0, and base=1 all yield NULL (postgres's native log(base,x) throws \"division by zero\" specifically for base=1; mongo's native $log throws for both cases — verified live)",
    seedRows: [{ x: -1, base: 2 }, { x: 8, base: 0 }, { x: 8, base: 1 }, { x: null, base: 2 }, { x: 8, base: 2 }],
    filterExpr: "is_null(log(x, base))",
  },
  // Phase 8b-2, batch 3 — DAX-derived Text core (+ split; see
  // docs/decisions.md's batch 3 entry for the full per-function contract
  // and its live-verification grounding). Seed data deliberately includes
  // mixed case, accented Latin (é, ñ), a multi-byte non-Latin-1 character
  // (emoji/CJK), leading/trailing whitespace, and empty strings BY
  // DEFAULT across this block, not as an afterthought — per the batch's
  // non-negotiable requirement. The standing mysql-collation rule (BINARY
  // forcing for case-sensitive string ops) is already baked into
  // sqlShared.ts's find() emission, applied from the outset, not
  // discovered afterward.
  {
    description: "upper(name) — locale-invariant default Unicode case mapping, proven with accented Latin (é -> É)",
    seedRows: [{ name: "café" }, { name: "CAFÉ" }, { name: null }],
    filterExpr: 'upper(name) = "CAFÉ"',
  },
  {
    description: "lower(name) — locale-invariant default Unicode case mapping, proven with accented Latin (É -> é)",
    seedRows: [{ name: "CAFÉ" }, { name: "café" }, { name: null }],
    filterExpr: 'lower(name) = "café"',
  },
  {
    description: "is_null(upper(name)) / is_null(lower(name)) NULL-safety — upper arm",
    seedRows: [{ name: null }, { name: "x" }],
    filterExpr: "is_null(upper(name))",
  },
  {
    description: "is_null(upper(name)) / is_null(lower(name)) NULL-safety — lower arm",
    seedRows: [{ name: null }, { name: "x" }],
    filterExpr: "is_null(lower(name))",
  },
  {
    description: "len(name) — character = Unicode CODE POINT count, not byte count, proven with accented + CJK + emoji (café ñ 日本語 🎉 = 12 code points, verified live to agree across mysql CHAR_LENGTH/postgres char_length/mongo $strLenCP)",
    seedRows: [{ name: "café ñ 日本語 🎉" }],
    filterExpr: "len(name) = 12",
  },
  {
    description: "len(name) on an empty string — 0, not NULL",
    seedRows: [{ name: "" }],
    filterExpr: "len(name) = 0",
  },
  {
    description: "is_null(len(name)) NULL-safety",
    seedRows: [{ name: null }, { name: "x" }],
    filterExpr: "is_null(len(name))",
  },
  {
    description: 'find(needle, haystack) default case-SENSITIVE, 1-based position — find("ada", name) matches lowercase "ada" at position 5',
    seedRows: [{ name: "the ada lovelace" }],
    filterExpr: 'find("ada", name) = 5',
  },
  {
    description: 'find(needle, haystack) case-SENSITIVE default does NOT match a differently-cased needle — find("ADA", name) = 0 (not found), same standing rule as contains/=',
    seedRows: [{ name: "the ada lovelace" }],
    filterExpr: 'find("ADA", name) = 0',
  },
  {
    description: 'find(needle, haystack, true) explicit case-INSENSITIVE — find("ADA", name, true) matches the lowercase occurrence at position 5',
    seedRows: [{ name: "the ada lovelace" }],
    filterExpr: 'find("ADA", name, true) = 5',
  },
  {
    description: "find with a needle not present anywhere — 0",
    seedRows: [{ name: "hello" }],
    filterExpr: 'find("zzz", name) = 0',
  },
  {
    description: "find with an empty needle — 1 (position 1), verified live to already be mysql/postgres's native behavior with no guard needed",
    seedRows: [{ name: "hello" }],
    filterExpr: 'find("", name) = 1',
  },
  {
    description: "is_null(find(...)) NULL-safety",
    seedRows: [{ name: null }, { name: "hello" }],
    filterExpr: 'is_null(find("a", name))',
  },
  {
    description: "left(name, n) with n larger than the string — clamps to the whole string (already consistent natively on mysql/postgres, no guard needed)",
    seedRows: [{ name: "hello" }],
    filterExpr: 'left(name, 100) = "hello"',
  },
  {
    description: "left(name, 0) — empty string",
    seedRows: [{ name: "hello" }],
    filterExpr: 'left(name, 0) = ""',
  },
  {
    description: "left(name, -1) — REQUIRED explicit GREATEST(n,0)/$max/Math.max clamp: negative n -> empty. Postgres's native LEFT('hello',-1) would otherwise return 'hell' ('all but last |n| chars'), genuinely diverging from mysql's native '' — verified live, homogenized by construction",
    seedRows: [{ name: "hello" }],
    filterExpr: 'left(name, -1) = ""',
  },
  {
    description: "is_null(left(name, 2)) NULL-safety",
    seedRows: [{ name: null }],
    filterExpr: "is_null(left(name, 2))",
  },
  {
    description: "right(name, n) with n larger than the string — clamps to the whole string",
    seedRows: [{ name: "hello" }],
    filterExpr: 'right(name, 100) = "hello"',
  },
  {
    description: "right(name, 0) — empty string",
    seedRows: [{ name: "hello" }],
    filterExpr: 'right(name, 0) = ""',
  },
  {
    description: "right(name, -1) — same REQUIRED clamp-to-0 contract as left, negative n -> empty",
    seedRows: [{ name: "hello" }],
    filterExpr: 'right(name, -1) = ""',
  },
  {
    description: "is_null(right(name, 2)) NULL-safety",
    seedRows: [{ name: null }],
    filterExpr: "is_null(right(name, 2))",
  },
  {
    description: "mid(name, start, n) with n larger than the remaining string — clamps to whatever's available from start onward",
    seedRows: [{ name: "hello" }],
    filterExpr: 'mid(name, 2, 100) = "ello"',
  },
  {
    description: "mid(name, start, 0) — empty string",
    seedRows: [{ name: "hello" }],
    filterExpr: 'mid(name, 2, 0) = ""',
  },
  {
    description: "mid(name, start, -1) — REQUIRED explicit GREATEST(n,0) clamp: negative length -> empty. Postgres's native substring(... for -1) would otherwise ERROR ('negative substring length not allowed'), verified live",
    seedRows: [{ name: "hello" }],
    filterExpr: 'mid(name, 2, -1) = ""',
  },
  {
    description: "mid(name, start<=0, n) — REQUIRED explicit GREATEST(start,1) clamp: non-positive start clamps to 1, not either engine's native negative/zero-start semantics (mysql counts back from the end; postgres treats it as a silently-clipped sliding window — two mutually incompatible natives, verified live, neither used)",
    seedRows: [{ name: "hello" }],
    filterExpr: 'mid(name, 0, 3) = "hel"',
  },
  {
    description: "is_null(mid(name, 2, 2)) NULL-safety",
    seedRows: [{ name: null }],
    filterExpr: "is_null(mid(name, 2, 2))",
  },
  {
    description: 'substitute(text, search, replacement) with an empty search string — REQUIRED explicit guard: text returned UNCHANGED. Mongo\'s native $replaceAll("abc","","X") would otherwise produce "XaXbXcX" (insert between every char), verified live to diverge from mysql/postgres\'s native REPLACE, which already no-ops',
    seedRows: [{ name: "abc" }],
    filterExpr: 'substitute(name, "", "X") = "abc"',
  },
  {
    description: 'substitute(text, search, replacement) where replacement overlaps/contains the search string — single left-to-right pass over the ORIGINAL string, not reprocessed: substitute("aaa","a","aa") = "aaaaaa" (3 independent replacements), never an infinite/recursive expansion',
    seedRows: [{ name: "aaa" }],
    filterExpr: 'substitute(name, "a", "aa") = "aaaaaa"',
  },
  {
    description: "is_null(substitute(name, 'a', 'b')) NULL-safety",
    seedRows: [{ name: null }],
    filterExpr: 'is_null(substitute(name, "a", "b"))',
  },
  {
    description: "split(text, delimiter, index) baseline with an ASCII delimiter",
    seedRows: [{ name: "a,b,c" }],
    filterExpr: 'split(name, ",", 2) = "b"',
  },
  {
    description: "split(text, delimiter, index) with a MULTI-BYTE delimiter (CJK character, not ASCII) — literal substring matching, already consistent everywhere since none of the native primitives treat the delimiter as regex",
    seedRows: [{ name: "a日b日c" }],
    filterExpr: 'split(name, "日", 2) = "b"',
  },
  {
    description: "split(text, \"\", index) with an EMPTY delimiter — REQUIRED explicit guard: NULL for every index. Mongo's native $split THROWS on an empty separator ('$split requires a non-empty separator'), verified live; guard must sit outside mongo's $let since vars evaluates eagerly",
    seedRows: [{ name: "abc" }],
    filterExpr: 'is_null(split(name, "", 1))',
  },
  {
    description: "split(text, delimiter, index) with index PAST the part count — out of range, NULL",
    seedRows: [{ name: "a,b,c" }],
    filterExpr: 'is_null(split(name, ",", 5))',
  },
  {
    description: "split(text, delimiter, index) with index < 1 — out of range, NULL (explicit bounds-checked on all 4, not relying on native out-of-range behavior, which differs by dialect)",
    seedRows: [{ name: "a,b,c" }],
    filterExpr: 'is_null(split(name, ",", 0))',
  },
  {
    description: "is_null(split(name, ',', 1)) NULL-safety",
    seedRows: [{ name: null }],
    filterExpr: 'is_null(split(name, ",", 1))',
  },
  {
    description: "trim(name) strips ASCII whitespace (space/tab/LF) from both ends, proven with an accented interior character so the trim boundary is unambiguous",
    seedRows: [{ name: "\t  café  \n" }],
    filterExpr: 'trim(name) = "café"',
  },
  {
    description: "trim(name) does NOT strip U+00A0 (non-breaking space) — pins the ASCII-only-whitespace contract against JS's own broader native .trim() (which WOULD strip NBSP), mysql/postgres's REGEXP_REPLACE and mongo's explicit chars-pinned $trim all agree it's left alone",
    seedRows: [{ name: "\u00a0café\u00a0" }],
    filterExpr: 'trim(name) = "\u00a0café\u00a0"',
  },
  {
    description: "is_null(trim(name)) NULL-safety",
    seedRows: [{ name: null }],
    filterExpr: "is_null(trim(name))",
  },
  {
    description: "rept(name, n) normal case",
    seedRows: [{ name: "ab" }],
    filterExpr: 'rept(name, 3) = "ababab"',
  },
  {
    description: "rept(name, 0) — empty string",
    seedRows: [{ name: "ab" }],
    filterExpr: 'rept(name, 0) = ""',
  },
  {
    description: "rept(name, negative) — clamps to 0 -> empty string (disclosed simplification, no error-propagation path)",
    seedRows: [{ name: "ab" }],
    filterExpr: 'rept(name, -3) = ""',
  },
  {
    description: "rept(name, n) repeat-count ceiling — capped at 1000 reps before the repeat runs (disclosed defensive ceiling, not a DAX/Excel-specific limit; REQUIRED for mongo since it has no native repeat-string operator at all). len(rept(name,2000)) proves the cap composes correctly with len's own code-point count",
    seedRows: [{ name: "a" }],
    filterExpr: "len(rept(name, 2000)) = 1000",
  },
  {
    description: "is_null(rept(name, 3)) NULL-safety",
    seedRows: [{ name: null }],
    filterExpr: "is_null(rept(name, 3))",
  },

  // --- Batch 4 (Phase 8b-2) — Coercion vocabulary. Contracts pinned in
  // docs/decisions.md's batch 4 entry; see sqlShared.ts's
  // compileCoercionFnSql / mongo.ts's compileCoercionFnMongo / residualEval.ts's
  // evalCoercionFn doc comments for the construction strategy. Every case
  // below is expected to agree across all 4 evaluators.
  {
    description: "is_null(to_number(x)) NULL-safety",
    seedRows: [{ x: null }],
    filterExpr: "is_null(to_number(x))",
  },
  {
    description: "to_number(x) with unparseable text — NULL, not an error",
    seedRows: [{ x: "abc" }],
    filterExpr: "is_null(to_number(x))",
  },
  {
    description: "to_number(x) trims surrounding whitespace before parsing",
    seedRows: [{ x: "  42  " }],
    filterExpr: "to_number(x) = 42",
  },
  {
    description: "to_number(x) accepts a leading +",
    seedRows: [{ x: "+5" }],
    filterExpr: "to_number(x) = 5",
  },
  {
    description: "to_number(x) accepts scientific notation",
    seedRows: [{ x: "1.5e3" }],
    filterExpr: "to_number(x) = 1500",
  },
  {
    description: "to_number(x) overflow guard — exponent magnitude past double range -> NULL, not a native overflow error/clamp (mysql clamps, postgres errors, mongo's $toDouble errors, all sidestepped by never reaching the native cast)",
    seedRows: [{ x: "1e400" }],
    filterExpr: "is_null(to_number(x))",
  },
  {
    description: "to_number(true) on a statically boolean-typed argument — NULL by contract (booleans are not coerced to numbers), detected via typeOfExpr at compile time so this agrees identically on every dialect",
    seedRows: [{ x: 1 }],
    filterExpr: "is_null(to_number(true))",
  },
  {
    description: "is_null(to_integer(x)) NULL-safety",
    seedRows: [{ x: null }],
    filterExpr: "is_null(to_integer(x))",
  },
  {
    description: "to_integer(x) truncates toward zero (not floor) on a positive fraction",
    seedRows: [{ x: "3.9" }],
    filterExpr: "to_integer(x) = 3",
  },
  {
    description: "to_integer(x) truncates toward zero (not floor) on a negative fraction",
    seedRows: [{ x: "-3.9" }],
    filterExpr: "to_integer(x) = -3",
  },
  {
    description: "to_integer(x) with unparseable text — NULL",
    seedRows: [{ x: "abc" }],
    filterExpr: "is_null(to_integer(x))",
  },
  {
    description: "is_null(to_text(x)) NULL-safety — NULL, never the string 'null'",
    seedRows: [{ x: null }],
    filterExpr: "is_null(to_text(x))",
  },
  {
    description: "to_text(x) on a float strips trailing zeros (6-decimal round then strip, not native FORMAT/to_char which diverge on locale/rounding mode)",
    seedRows: [{ x: 3.5 }],
    filterExpr: 'to_text(x) = "3.5"',
  },
  {
    description: "to_text(x) on a whole number — no trailing decimal point",
    seedRows: [{ x: 42 }],
    filterExpr: 'to_text(x) = "42"',
  },
  {
    description: "to_text(x) on already-text input — passthrough unchanged",
    seedRows: [{ x: "hello" }],
    filterExpr: 'to_text(x) = "hello"',
  },
  {
    description: "to_text(true) on a statically boolean-typed argument — 'true'/'false' text, not '1'/'0' (postgres has no implicit boolean->numeric coercion; detected via typeOfExpr so this agrees on every dialect including mysql, which has no real boolean column type)",
    seedRows: [{ x: 1 }],
    filterExpr: 'to_text(true) = "true"',
  },
  {
    description: "is_null(format_number(x, 2)) NULL-safety",
    seedRows: [{ x: null }],
    filterExpr: "is_null(format_number(x, 2))",
  },
  {
    description: "format_number(x, 0) rounds exactly-.5 AWAY from zero on a positive value (round-half-away-from-zero, not banker's rounding)",
    seedRows: [{ x: 2.5 }],
    filterExpr: 'format_number(x, 0) = "3"',
  },
  {
    description: "format_number(x, 0) rounds exactly-.5 AWAY from zero on a negative value",
    seedRows: [{ x: -2.5 }],
    filterExpr: 'format_number(x, 0) = "-3"',
  },
  {
    description: "format_number(x, 3) zero-pads to the exact requested decimal count — never stripped (unlike to_text's variable-precision display)",
    seedRows: [{ x: 1.5 }],
    filterExpr: 'format_number(x, 3) = "1.500"',
  },
  {
    description: "format_number(x, decimals) clamps a negative decimals arg to 0 — explicit NULL-guard-before-GREATEST/LEAST (postgres's GREATEST/LEAST and mongo's $min/$max both IGNORE null operands, diverging from mysql's null-propagating GREATEST/LEAST — homogenized here by construction)",
    seedRows: [{ x: 1.6 }],
    filterExpr: 'format_number(x, -1) = "2"',
  },
  {
    description: "format_number(x, decimals) with unparseable value text — NULL",
    seedRows: [{ x: "abc" }],
    filterExpr: "is_null(format_number(x, 2))",
  },
  {
    description: "is_null(to_boolean(x)) NULL-safety",
    seedRows: [{ x: null }],
    filterExpr: "is_null(to_boolean(x))",
  },
  {
    description: 'to_boolean(x) is case-insensitive on "TRUE"',
    seedRows: [{ x: "TRUE" }],
    filterExpr: "to_boolean(x) = true",
  },
  {
    description: 'to_boolean(x) maps the string "1" to true',
    seedRows: [{ x: "1" }],
    filterExpr: "to_boolean(x) = true",
  },
  {
    description: 'to_boolean(x) is case-insensitive on "False"',
    seedRows: [{ x: "False" }],
    filterExpr: "to_boolean(x) = false",
  },
  {
    description: 'to_boolean(x) maps the string "0" to false',
    seedRows: [{ x: "0" }],
    filterExpr: "to_boolean(x) = false",
  },
  {
    description: "to_boolean(x) maps the runtime number 1 to true",
    seedRows: [{ x: 1 }],
    filterExpr: "to_boolean(x) = true",
  },
  {
    description: "to_boolean(x) maps the runtime number 0 to false",
    seedRows: [{ x: 0 }],
    filterExpr: "to_boolean(x) = false",
  },
  {
    description: "to_boolean(x) with an unrecognized string — NULL",
    seedRows: [{ x: "maybe" }],
    filterExpr: "is_null(to_boolean(x))",
  },
  {
    description: "to_boolean(true) on a statically boolean-typed argument — passthrough",
    seedRows: [{ x: 1 }],
    filterExpr: "to_boolean(true) = true",
  },
  {
    description: "is_null(to_date(x)) NULL-safety",
    seedRows: [{ x: null }],
    filterExpr: "is_null(to_date(x))",
  },
  {
    description: "to_date(x) accepts a date-only ISO-8601 string, defaulting the time to midnight UTC (UTC pin applied from the outset, per the date decisions)",
    seedRows: [{ x: "2024-03-05" }],
    filterExpr: 'to_date(x) = "2024-03-05T00:00:00Z"',
  },
  {
    description: "to_date(x) accepts a full ISO-8601 datetime with a space separator (not just 'T')",
    seedRows: [{ x: "2024-03-05 13:45:09" }],
    filterExpr: 'to_date(x) = "2024-03-05T13:45:09Z"',
  },
  {
    description: "to_date(x) with non-ISO input — NULL, not an error (ISO-only fast path per the proposal)",
    seedRows: [{ x: "03/05/2024" }],
    filterExpr: "is_null(to_date(x))",
  },
  {
    description: "to_date(x) with an out-of-calendar-bounds month — NULL",
    seedRows: [{ x: "2024-13-05" }],
    filterExpr: "is_null(to_date(x))",
  },
  {
    description: "to_date(x) with a wrong-typed (numeric) argument — NULL",
    seedRows: [{ x: 12345 }],
    filterExpr: "is_null(to_date(x))",
  },
  {
    description:
      "Item 3, Condition 2 — a text function call with two BARE literal string args and no column operand anywhere in the call: proves Postgres resolves an unknown-typed text literal fine with no adjacent typed operand at all (no ambiguousCast/castAmbiguousLiteral needed for strings — see sqlShared.ts's castAmbiguousLiteral doc comment)",
    seedRows: [{ dummy: 1 }],
    filterExpr: 'substitute("hello world", "world", "there") = "hello there"',
  },
  {
    description:
      "Item 3, Condition 4 — literal-over-literal division downstream of a CASE whose branches are bare numeric literals: proves castAmbiguousLiteral's number rule (Fix 1: numeric, exact decimal — not double precision, not integer) avoids both Postgres integer-division truncation AND (per Fix 1's 2a finding) float64 collision on large integers. If this rule cast to `integer` instead, Postgres would compute 2/4=0 (int division) while mysql/mongo compute 0.5, diverging.",
    seedRows: [{ dummy: 1 }],
    filterExpr: "if(dummy = 1, 2, 4) / 4 = 0.5",
  },
  {
    description:
      "Item 3 follow-up 2b + Fix 2 — quotient()'s pinned truncate-toward-zero contract (batch 1) still holds when its dividend comes from a CASE branch that's now explicitly CAST(... AS numeric) rather than a plain column: quotient(-7, 3) must still be -2 (truncate toward zero, not floor), not -3. This case was left red on mysql through the follow-up 2b investigation (eager truncSql built before arg(1)'s own placeholder, desyncing mysql's positional bind order whenever the dividend itself pushes params) — Fix 2's closure fix is what makes it agree here.",
    seedRows: [{ flag: 1 }],
    filterExpr: "quotient(if(flag = 1, -7, 0), 3) = -2",
  },
  {
    description:
      "Item 3 follow-up 2b — mod()'s pinned sign-of-divisor contract (batch 1, DAX/Excel convention) still holds when its dividend comes from a CASE branch that's now explicitly CAST(... AS numeric): mod(7, -3) must still be -2 (sign of the divisor), not mysql/postgres-native MOD's dividend-sign result.",
    seedRows: [{ flag: 1 }],
    filterExpr: "mod(if(flag = 1, 7, 0), -3) = -2",
  },
  {
    description:
      "Fix 2 audit finding — is_number(5) with a literal argument (not a field reference, unlike the is_number(name) case above): compileTrueTypeSql previously reused a precomputed `target` string verbatim at 2-3 embed points, desyncing mysql's positional ? count from its params array whenever the argument itself pushed a param. A field reference never triggered it (quoteIdent output has no placeholders); a literal does. Must be true on every evaluator, not just non-erroring.",
    seedRows: [{ dummy: 1 }, { dummy: 2 }],
    filterExpr: "is_number(5)",
  },
  {
    description:
      'Fix 2 audit finding — is_text("abc") with a literal argument, mirrors is_number(5) above for compileTrueTypeSql\'s text branch. Must be true on every evaluator.',
    seedRows: [{ dummy: 1 }, { dummy: 2 }],
    filterExpr: 'is_text("abc")',
  },
  {
    // Fix 3 backfill (Item 1, pre-batch-5 hardening): castAmbiguousLiteral
    // casts both CASE branches to timestamptz on postgres; dbHarness.ts
    // previously could only seed number/boolean/text columns, so this case
    // hard-errored ("operator does not exist: timestamp with time zone =
    // text") and was parked as a comment. dbHarness.ts now infers a
    // genuine DATE (mysql) / date (postgres) column for the explicitly
    // opted-in `event_date` column. mongo's compileExpr now applies the
    // analogous fix (ISO_DATE_LITERAL_RE + planDateStringCast, scoped to
    // `conditional` branches — see mongo.ts's doc comment above
    // compileConditionalBranch) — all 4 evaluators AGREE (2/2 rows),
    // confirming both casts are correct. See docs/decisions.md's Item 1 /
    // mongo-date-literal-coercion entries for the full history (this case
    // was briefly a known, declared mongo divergence before the fix
    // landed).
    description:
      'conditional whose branches are date-shaped string literals, compared against a real `date`-typed column across all 3 dialects — mysql/postgres/mongo/residual AGREE (2/2 rows)',
    seedRows: [
      { flag: 1, event_date: "2024-01-15" },
      { flag: 0, event_date: "2024-06-01" },
    ],
    dateColumns: ["event_date"],
    filterExpr: 'if(flag = 1, "2024-01-15", "2024-06-01") = event_date',
  },
  {
    // Addition 1 (pre-batch-5 hardening, mongo date-literal coercion
    // review): the mongo conditional-branch fix above accepts a known
    // risk — it triggers purely from the CASE branches' own content
    // shape (ISO-8601-looking strings), with no visibility into what the
    // CASE result is later compared against. This case is that exact
    // false positive: the SAME date-shaped-branch CASE, but compared
    // against a plain TEXT column (no `dateColumns` opt-in) seeded with
    // matching ISO-string content, not a real date column.
    //
    // KNOWN, REAL, DECLARED — not a harness bug, not silently patched
    // over. Same heuristic, genuinely different failure mode per
    // dialect, confirmed live:
    //   - mysql: castAmbiguousLiteral's mysqlType is null for the date
    //     branch (no-op there by design — see sqlShared.ts), so the CASE
    //     stays a plain string, compared against a VARCHAR column
    //     normally. Matches (2/2), agrees with residual.
    //   - postgres: the branches are cast to timestamptz unconditionally
    //     (already-shipped, content-shape-only trigger — this is not new
    //     behavior, this case is the first to exercise it against a real
    //     TEXT column). Comparing timestamptz to text has no operator on
    //     postgres — hard ERRORS ("operator does not exist: timestamp
    //     with time zone = text"). Loud failure.
    //   - mongo: the branches are wrapped in $toDate by this fix, then
    //     compared via $eq against a plain string field — Date never
    //     equals string, so this silently matches 0 rows. Quiet failure.
    //   - residual: plain in-memory string comparison, matches (2/2),
    //     agrees with mysql.
    // So the SAME heuristic produces a loud, self-evident failure on
    // postgres and a silent, wrong-answer failure on mongo — not the
    // identical risk profile, even though both dialects apply "the same
    // kind" of shape-driven cast. This matters more in this product than
    // in a generic ETL tool: date-stored-as-text is one of the core
    // dirty-data pathologies Nia Core exists to clean, so this is a
    // realistic case, not an exotic one.
    //
    // The sanctioned path for an INTENTIONAL date comparison remains an
    // explicit `to_date()` call in the expression, not this shape
    // heuristic — see docs/decisions.md's mongo-date-literal-coercion
    // entry. Not fixed further here: doing so would mean either (a)
    // reverting the conditional fix's whole premise (no schema signal
    // exists to disambiguate), or (b) postgres's own already-shipped
    // behavior, neither of which is this session's scope.
    description:
      'FALSE POSITIVE (declared, not a bug): same date-shaped-CASE-branches shape as the case above, but compared against a plain TEXT column (no dateColumns) holding matching ISO string content, not a real date column — mysql AGREES with residual (2/2, string-vs-string no-op); postgres ERRORS loudly (timestamptz = text has no operator, already-shipped cast, first case to exercise it against text); mongo DIVERGES silently (0 vs 2, $toDate-wrapped branches vs a plain string field never match) — see the comment above',
    seedRows: [
      { flag: 1, notes: "2024-01-15" },
      { flag: 0, notes: "2024-06-01" },
    ],
    filterExpr: 'if(flag = 1, "2024-01-15", "2024-06-01") = notes',
    expectedDivergence: {
      reason:
        "postgres ERRORs (timestamptz = text has no operator) and mongo DIVERGEs silently (0 vs 2 rows, $toDate-wrapped CASE branches vs a plain string field never match $eq) — a declared, permanent consequence of the content-shape-only date heuristic (postgres: already-shipped; mongo: this session's conditional-branch fix), not a bug. mysql and residual agree with each other.",
      decisionsRef:
        "docs/decisions.md — 'Addition 1 — the false positive this heuristic accepts is itself an agreement case, not left latent' (mongo-date-literal-coercion entry)",
    },
  },

  // --- Batch 5 (Phase 8b-2) — Date-part vocabulary: year, month, day, hour,
  // minute, second, quarter, weekday, date_diff, date_add. Reference
  // timestamp for the single-arg extraction cases below is
  // "2024-03-07T15:42:33" — a Thursday (manually verified: 2024-01-01 is a
  // Monday, so 2024-03-01 is day 61 -> Friday, +6 days -> 2024-03-07 is a
  // Thursday), ISO weekday 4, quarter 1. Uses a real `dateColumns`-opted-in
  // typed column as the primary path per the batch's own rule (string-input
  // cases are reserved for the wrong-typed-input coverage below).
  {
    description: "year(d) extracts the calendar year from a real typed date column",
    seedRows: [{ d: "2024-03-07T15:42:33" }],
    dateColumns: ["d"],
    filterExpr: "year(d) = 2024",
  },
  {
    description: "month(d) extracts the 1-12 calendar month from a real typed date column",
    seedRows: [{ d: "2024-03-07T15:42:33" }],
    dateColumns: ["d"],
    filterExpr: "month(d) = 3",
  },
  {
    description: "day(d) extracts the day-of-month from a real typed date column",
    seedRows: [{ d: "2024-03-07T15:42:33" }],
    dateColumns: ["d"],
    filterExpr: "day(d) = 7",
  },
  {
    description: "hour(d) extracts the UTC hour from a real typed date column",
    seedRows: [{ d: "2024-03-07T15:42:33" }],
    dateColumns: ["d"],
    filterExpr: "hour(d) = 15",
  },
  {
    description: "minute(d) extracts the UTC minute from a real typed date column",
    seedRows: [{ d: "2024-03-07T15:42:33" }],
    dateColumns: ["d"],
    filterExpr: "minute(d) = 42",
  },
  {
    description: "second(d) extracts the UTC second from a real typed date column",
    seedRows: [{ d: "2024-03-07T15:42:33" }],
    dateColumns: ["d"],
    filterExpr: "second(d) = 33",
  },
  {
    description: "quarter(d) = 1 for a March date (Q1 boundary: Jan-Mar)",
    seedRows: [{ d: "2024-03-07T15:42:33" }],
    dateColumns: ["d"],
    filterExpr: "quarter(d) = 1",
  },
  {
    description: "quarter(d) boundaries — Q2 starts April 1, Q3 starts July 1, Q4 starts October 1 (all 4 quarters pinned in one case via 4 seed rows)",
    seedRows: [
      { d: "2024-04-01T00:00:00" },
      { d: "2024-07-01T00:00:00" },
      { d: "2024-10-01T00:00:00" },
      { d: "2024-12-31T23:59:59" },
    ],
    dateColumns: ["d"],
    filterExpr: "quarter(d) = 2 or quarter(d) = 3 or quarter(d) = 4",
  },
  {
    description: "weekday(d) = 4 for 2024-03-07, a Thursday — ISO numbering (Mon=1..Sun=7), not the native 0-indexed-from-Sunday convention several engines default to",
    seedRows: [{ d: "2024-03-07T15:42:33" }],
    dateColumns: ["d"],
    filterExpr: "weekday(d) = 4",
  },
  {
    description: "weekday(d) = 7 for a Sunday (2024-03-10) — pins the ISO high end, since a native 0-indexed-from-Sunday weekday function would report 0, not 7, here",
    seedRows: [{ d: "2024-03-10T00:00:00" }],
    dateColumns: ["d"],
    filterExpr: "weekday(d) = 7",
  },
  {
    description: "weekday(d) = 1 for a Monday (2024-03-04) — pins the ISO low end",
    seedRows: [{ d: "2024-03-04T00:00:00" }],
    dateColumns: ["d"],
    filterExpr: "weekday(d) = 1",
  },

  // NULL-input coverage, minimum one per function per the standing batch
  // protocol (all 10 functions).
  {
    description: "is_null(year(d)) NULL-safety",
    seedRows: [{ d: null }],
    dateColumns: ["d"],
    filterExpr: "is_null(year(d))",
  },
  {
    description: "is_null(month(d)) NULL-safety",
    seedRows: [{ d: null }],
    dateColumns: ["d"],
    filterExpr: "is_null(month(d))",
  },
  {
    description: "is_null(day(d)) NULL-safety",
    seedRows: [{ d: null }],
    dateColumns: ["d"],
    filterExpr: "is_null(day(d))",
  },
  {
    description: "is_null(hour(d)) NULL-safety",
    seedRows: [{ d: null }],
    dateColumns: ["d"],
    filterExpr: "is_null(hour(d))",
  },
  {
    description: "is_null(minute(d)) NULL-safety",
    seedRows: [{ d: null }],
    dateColumns: ["d"],
    filterExpr: "is_null(minute(d))",
  },
  {
    description: "is_null(second(d)) NULL-safety",
    seedRows: [{ d: null }],
    dateColumns: ["d"],
    filterExpr: "is_null(second(d))",
  },
  {
    description: "is_null(quarter(d)) NULL-safety",
    seedRows: [{ d: null }],
    dateColumns: ["d"],
    filterExpr: "is_null(quarter(d))",
  },
  {
    description: "is_null(weekday(d)) NULL-safety",
    seedRows: [{ d: null }],
    dateColumns: ["d"],
    filterExpr: "is_null(weekday(d))",
  },
  {
    description: "is_null(date_diff(start, end, \"day\")) NULL-safety when start is NULL",
    seedRows: [{ start: null, end: "2024-01-10" }],
    dateColumns: ["start", "end"],
    filterExpr: 'is_null(date_diff(start, end, "day"))',
  },
  {
    description: "is_null(date_add(base, 1, \"day\")) NULL-safety when base is NULL",
    seedRows: [{ base: null }],
    dateColumns: ["base"],
    filterExpr: 'is_null(date_add(base, 1, "day"))',
  },

  // Wrong-typed / non-date-string-input coverage, minimum one per function.
  // These deliberately do NOT use dateColumns — the whole point is a plain
  // string/number column holding non-date content.
  {
    description: "year(x) with a non-ISO-shaped string argument — NULL, not an error",
    seedRows: [{ x: "not-a-date" }],
    filterExpr: "is_null(year(x))",
  },
  {
    description: "month(x) with a wrong-typed numeric argument — NULL",
    seedRows: [{ x: 12345 }],
    filterExpr: "is_null(month(x))",
  },
  {
    description: "day(x) with a non-ISO-shaped string argument — NULL",
    seedRows: [{ x: "03/07/2024" }],
    filterExpr: "is_null(day(x))",
  },
  {
    description: "hour(x) with a wrong-typed numeric argument — NULL",
    seedRows: [{ x: 42 }],
    filterExpr: "is_null(hour(x))",
  },
  {
    description: "minute(x) with a non-ISO-shaped string argument — NULL",
    seedRows: [{ x: "hello" }],
    filterExpr: "is_null(minute(x))",
  },
  {
    description: "second(x) with a wrong-typed numeric argument — NULL",
    seedRows: [{ x: 7 }],
    filterExpr: "is_null(second(x))",
  },
  {
    description: "quarter(x) with a non-ISO-shaped string argument — NULL",
    seedRows: [{ x: "Q1-2024" }],
    filterExpr: "is_null(quarter(x))",
  },
  {
    description: "weekday(x) with a wrong-typed numeric argument — NULL",
    seedRows: [{ x: 4 }],
    filterExpr: "is_null(weekday(x))",
  },
  {
    description: "date_diff(x, y, \"day\") with a non-ISO-shaped string first argument — NULL",
    seedRows: [{ x: "nope", y: "2024-01-10" }],
    filterExpr: 'is_null(date_diff(x, y, "day"))',
  },
  {
    description: "date_add(x, 1, \"day\") with a non-ISO-shaped string base argument — NULL",
    seedRows: [{ x: "nope" }],
    filterExpr: 'is_null(date_add(x, 1, "day"))',
  },

  // date_diff — sign direction, calendar-boundary (not elapsed-time)
  // truncation for month/year, and sub-day truncation-toward-zero.
  {
    description: "date_diff(start, end, \"day\") sign — positive when end is after start",
    seedRows: [{ start: "2024-01-01", end: "2024-01-10" }],
    dateColumns: ["start", "end"],
    filterExpr: 'date_diff(start, end, "day") = 9',
  },
  {
    description: "date_diff(start, end, \"day\") sign — negative when end is before start (swapped operands of the case above)",
    seedRows: [{ start: "2024-01-10", end: "2024-01-01" }],
    dateColumns: ["start", "end"],
    filterExpr: 'date_diff(start, end, "day") = -9',
  },
  {
    description: "date_diff(..., \"month\") counts CALENDAR MONTH BOUNDARIES crossed, not elapsed time rounded — Jan 31 to Mar 1 is only 29 days elapsed (less than 2 full months) but crosses 2 month boundaries (Jan->Feb, Feb->Mar), so the result is 2",
    seedRows: [{ start: "2024-01-31", end: "2024-03-01" }],
    dateColumns: ["start", "end"],
    filterExpr: 'date_diff(start, end, "month") = 2',
  },
  {
    description: "date_diff(..., \"year\") counts calendar year boundaries crossed, same non-elapsed-time convention as month above",
    seedRows: [{ start: "2023-06-15", end: "2024-01-01" }],
    dateColumns: ["start", "end"],
    filterExpr: 'date_diff(start, end, "year") = 1',
  },
  {
    description: "date_diff(..., \"day\") truncates toward zero on a sub-day span — under 24h elapsed (23:59:59) still rounds DOWN to 0 whole days, not up to 1",
    seedRows: [{ start: "2024-01-01T00:00:00", end: "2024-01-01T23:59:59" }],
    dateColumns: ["start", "end"],
    filterExpr: 'date_diff(start, end, "day") = 0',
  },
  {
    description: "date_diff(..., \"hour\") truncates toward zero on a sub-hour remainder (90 minutes = 1 whole hour, not rounded to 2)",
    seedRows: [{ start: "2024-01-01T00:00:00", end: "2024-01-01T01:30:00" }],
    dateColumns: ["start", "end"],
    filterExpr: 'date_diff(start, end, "hour") = 1',
  },

  // date_add — month-end clamping (native interval arithmetic on
  // mysql/postgres/mongo, hand-rolled clamp in residualEval), negative n,
  // and a year-unit clamp.
  {
    description: "date_add(base, 1, \"month\") on Jan 31 in a LEAP year clamps to Feb 29, it does not overflow into March",
    seedRows: [{ base: "2024-01-31T00:00:00" }],
    dateColumns: ["base"],
    filterExpr: 'date_add(base, 1, "month") = "2024-02-29T00:00:00Z"',
  },
  {
    description: "date_add(base, 1, \"month\") on Jan 31 in a NON-leap year clamps to Feb 28",
    seedRows: [{ base: "2023-01-31T00:00:00" }],
    dateColumns: ["base"],
    filterExpr: 'date_add(base, 1, "month") = "2023-02-28T00:00:00Z"',
  },
  {
    description: "date_add(base, -1, \"month\") with a negative n also clamps at the target month-end (Mar 31 - 1 month -> Feb 29 in a leap year)",
    seedRows: [{ base: "2024-03-31T00:00:00" }],
    dateColumns: ["base"],
    filterExpr: 'date_add(base, -1, "month") = "2024-02-29T00:00:00Z"',
  },
  {
    description: "date_add(base, 1, \"year\") on Feb 29 (leap day) clamps to Feb 28 in the following, non-leap, target year",
    seedRows: [{ base: "2024-02-29T00:00:00" }],
    dateColumns: ["base"],
    filterExpr: 'date_add(base, 1, "year") = "2025-02-28T00:00:00Z"',
  },
  {
    description: "date_add(base, n, \"minute\") for sub-day units is plain arithmetic, no clamping involved (90 minutes past midnight)",
    seedRows: [{ base: "2024-01-01T00:00:00" }],
    dateColumns: ["base"],
    filterExpr: 'date_add(base, 90, "minute") = "2024-01-01T01:30:00Z"',
  },
  {
    description: "date_add(base, n, \"day\") plain day arithmetic",
    seedRows: [{ base: "2024-01-01T00:00:00" }],
    dateColumns: ["base"],
    filterExpr: 'date_add(base, 5, "day") = "2024-01-06T00:00:00Z"',
  },

  // DST-transition case — 2024-03-10 is the US spring-forward instant
  // (02:00 local -> 03:00 local, America/New_York). Pinning that a
  // date_diff spanning this instant, expressed entirely in UTC, reports
  // the plain elapsed-hour count with no local-DST adjustment anywhere in
  // the pipeline: confirms the UTC-everywhere pin makes DST moot by
  // construction (no evaluator ever converts to/from a local zone).
  {
    description: "date_diff across the 2024-03-10 US DST spring-forward instant reports plain UTC elapsed hours (2), unaffected by any local-timezone DST rule — UTC-everywhere makes DST moot",
    seedRows: [{ start: "2024-03-10T06:00:00", end: "2024-03-10T08:00:00" }],
    dateColumns: ["start", "end"],
    filterExpr: 'date_diff(start, end, "hour") = 2',
  },

  // Phase 8b-2 Follow-up 1, Condition 3 — cross-fragment arg(n)-desync
  // regression guard. mysql's `?` placeholders bind by the driver's
  // strict LEFT-TO-RIGHT SCAN of the FINAL query TEXT, not by any number
  // baked into the placeholder itself (unlike postgres's `$N`, which
  // binds by number regardless of physical position — this is why this
  // case is mysql-only by construction, not an oversight). Before
  // Follow-up 1's fix, compileSql's single shared `params` array is
  // filled in STEP-ARRAY order: a `filter` step processed before a
  // `computed_field` step pushes the filter's literal at params[0] and
  // the computed_field's literal at params[1] — but buildEtlReadQuery
  // (queryBuilder.ts) always assembles `SELECT *, <selectSql> FROM ...
  // WHERE <whereSql>`, i.e. the computed_field's `?` (from selectSql)
  // physically precedes the filter's `?` (from whereSql) in the final
  // text. mysql's driver therefore binds params[0] (the filter's `5`)
  // into the FIRST `?` it scans (the computed_field's ROUND digits slot)
  // and params[1] (the computed_field's `2`) into the SECOND `?` it scans
  // (the filter's age comparison) — i.e. `ROUND(price, 5)` and
  // `WHERE age > 2` instead of the authored `ROUND(price, 2)` and
  // `WHERE age > 5`. This is observable two ways at once: the filter
  // silently admits an extra row (age=3 passes `age > 2` but not the
  // authored `age > 5`), and the surviving row's `rounded` column is
  // computed to the wrong precision. See docs/decisions.md's Phase 8b-2
  // Follow-up 1 entry for the live before/after result of running this
  // case. Keep this case permanently, even after the fix lands — it's
  // the only live regression guard for compileSql's cross-fragment param
  // ordering.
  {
    description:
      "cross-fragment param-order regression guard (Follow-up 1 / Condition 3): a filter step (age > 5, literal -> whereSql) followed by a computed_field step (round(price, 2), literal -> selectSql) — mysql only, proves compileSql's shared params array stays correctly bound to each literal's own placeholder once selectSql/whereSql are combined into one query text, regardless of step-array push order vs. final physical text order",
    seedRows: [
      { age: 3, price: 1.2345 },
      { age: 10, price: 6.789 },
    ],
    filterExpr: "age > 5", // unused when `steps` is set — kept as a human-readable summary of the filter half of `steps` below.
    steps: [
      { kind: "filter", expr: parseExpr("age > 5") },
      { kind: "computed_field", name: "rounded", expression: parseExpr("round(price, 2)") },
    ],
  },

  // --- Batch 6 (Phase 8b-2) — Cleaning vocabulary: regex_match,
  // regex_extract, regex_replace, canonicalize, strip_accents, parse_date,
  // parse_number. Contracts pinned in docs/decisions.md's batch 6 entry;
  // see sqlShared.ts's compileCleanFnSql and mongo.ts's compileCleanFnMongo
  // doc comments for the per-dialect construction. Mixed pushability means
  // several cases below intentionally run with fewer than 4 live arms —
  // ops-agreement.ts's `plan.residualCount > 0` check WARNs and skips a
  // dialect arm outright rather than erroring, so a mysql-skipped
  // regex_extract case, a mongo-skipped regex_replace/canonicalize case,
  // and an all-3-dialects-skipped strip_accents case are all expected,
  // not a bug — see FN_PUSHABILITY's batch 6 entries in types.ts for
  // exactly which dialects each function is pushable on.

  // regex_match — pushable on every dialect.
  {
    description: "regex_match(name, pattern) — basic anchored match, true on every dialect",
    seedRows: [{ name: "Ada" }, { name: "Bob" }],
    filterExpr: 'regex_match(name, "^A")',
  },
  {
    description: "regex_match(name, pattern, true) — explicit case-insensitive flag",
    seedRows: [{ name: "ada" }, { name: "BOB" }],
    filterExpr: 'regex_match(name, "^A", true)',
  },
  {
    description: "is_null(regex_match(name, pattern)) NULL-safety",
    seedRows: [{ name: null }],
    filterExpr: 'is_null(regex_match(name, "^A"))',
  },

  // regex_extract — mysql non-pushable (REGEXP_SUBSTR has no capture-group
  // index parameter); postgres/mongo pushable via native group extraction.
  {
    description: "regex_extract(text, pattern, group) — numbered capture group (mysql arm skipped, not pushable there)",
    seedRows: [{ text: "abc-42" }],
    filterExpr: 'regex_extract(text, "([a-z]+)-([0-9]+)", 2) = "42"',
  },
  {
    description: "regex_extract(text, pattern, 0) — group 0 is the whole match, not a capture group (mysql arm skipped)",
    seedRows: [{ text: "abc-42" }],
    filterExpr: 'regex_extract(text, "[0-9]+", 0) = "42"',
  },
  {
    description: "regex_extract(text, pattern, group) — out-of-range group index resolves to NULL, not an error, on every evaluated arm (mysql arm skipped)",
    seedRows: [{ text: "abc-42" }],
    filterExpr: 'is_null(regex_extract(text, "([a-z]+)-([0-9]+)", 5))',
  },

  // regex_replace — mysql/postgres pushable (mysql needs a compile-time
  // ICU-vs-backslash backreference-syntax translation, postgres's native
  // syntax already matches the portable \N grammar); mongo has no
  // regex-based replace pipeline operator (arm skipped).
  {
    description: "regex_replace(text, pattern, replacement) — literal replacement, no backreferences (mongo arm skipped)",
    seedRows: [{ text: "abc-42" }],
    filterExpr: 'regex_replace(text, "[0-9]+", "NUM") = "abc-NUM"',
  },
  {
    description: 'regex_replace with \\N backreferences (portable syntax) — mysql compile-time-translates to ICU $N, postgres native syntax already matches (mongo arm skipped)',
    seedRows: [{ text: "abc-42" }],
    filterExpr: 'regex_replace(text, "([a-z]+)-([0-9]+)", "\\2-\\1") = "42-abc"',
  },
  {
    description: "is_null(regex_replace(text, pattern, replacement)) NULL-safety (mongo arm skipped)",
    seedRows: [{ text: null }],
    filterExpr: 'is_null(regex_replace(text, "x", "y"))',
  },

  // --- Item 3 edge-case probes: does batch 6's regex vocabulary agree
  // outside the basic anchors/classes/greedy-quantifier patterns actually
  // exercised above? Each of these is a live, unpinned probe — not yet a
  // declared-supported-subset claim. See docs/decisions.md's "Batch 6
  // regex flavor divergence" entry for how these results get formalized.
  {
    description: "Item 3 probe: lazy quantifier (+?) — does non-greedy matching agree across mysql ICU / postgres ARE / mongo PCRE / residual JS RegExp?",
    seedRows: [{ text: "<a><b>" }],
    filterExpr: 'regex_extract(text, "<.+?>", 0) = "<a>"',
  },
  {
    description: "Item 3 probe: \\d Perl-style shorthand digit class, positive+negative pair — does postgres's default ARE flavor (not POSIX ERE) accept \\d the same as mysql ICU / mongo PCRE / residual JS?",
    seedRows: [{ text: "abc123" }, { text: "abcxyz" }],
    filterExpr: 'regex_match(text, "\\d+")',
  },
  {
    description: "Item 3 probe: in-pattern backreference (\\1 referring back within the same pattern, not a replacement string), positive+negative pair — matches doubled words only",
    seedRows: [{ text: "the the cat" }, { text: "the cat sat" }],
    filterExpr: 'regex_match(text, "(\\w+) \\1")',
  },
  {
    description: "Item 3 probe: lookahead assertion ((?=...)), positive+negative pair — a coincidental single-row match can't distinguish real zero-width lookahead from a degenerate reparse, so this pins both 'foo123' (must match) and 'foobar' (must not) across mysql ICU / postgres ARE / mongo PCRE / residual JS",
    seedRows: [{ text: "foo123" }, { text: "foobar" }],
    filterExpr: 'regex_match(text, "foo(?=\\d)")',
  },
  {
    description: "Item 3 probe: multiline anchor (^) against a value containing an embedded newline — does ^ match only start-of-string (no multiline flag exposed by this vocabulary) consistently across all 4 evaluators?",
    seedRows: [{ text: "first\nsecond" }],
    filterExpr: 'regex_match(text, "^second")',
  },

  // canonicalize — mysql/postgres pushable via REGEXP_REPLACE-based
  // whitespace-run collapse + border-trim; mongo has no regex-replace
  // primitive to build it from (arm skipped).
  {
    description: "canonicalize(text) collapses interior whitespace runs to one space and trims both ends (mongo arm skipped)",
    seedRows: [{ text: "  hello   world  " }],
    filterExpr: 'canonicalize(text) = "hello world"',
  },
  {
    description: "is_null(canonicalize(text)) NULL-safety (mongo arm skipped)",
    seedRows: [{ text: null }],
    filterExpr: "is_null(canonicalize(text))",
  },

  // strip_accents — non-pushable on every dialect (no native NFD +
  // combining-mark-strip primitive anywhere); all 3 pushdown arms are
  // skipped by ops-agreement.ts's residualCount check, leaving only the
  // residual arm to evaluate — still worth keeping live as a regression
  // guard that pushdown correctly falls back to residual instead of
  // erroring, and that the residual evaluator itself behaves correctly.
  {
    description: "strip_accents(text) strips NFD combining marks — non-pushable everywhere, residual-only (all 3 pushdown arms skipped)",
    seedRows: [{ text: "café" }],
    filterExpr: 'strip_accents(text) = "cafe"',
  },
  {
    description: "is_null(strip_accents(text)) NULL-safety — residual-only (all 3 pushdown arms skipped)",
    seedRows: [{ text: null }],
    filterExpr: "is_null(strip_accents(text))",
  },

  // parse_date — pushable on every dialect via the compile-time
  // format-token-offset construction (never a native date-string parser).
  // Output is a plain string in the same ISO-8601 canonical shape the
  // batch-5 date-part functions consume, so no dateColumns opt-in is
  // needed here — comparisons stay plain string equality.
  {
    description: "parse_date(text, \"YYYY-MM-DD\") — date-only format, defaults time-of-day to midnight UTC",
    seedRows: [{ text: "2024-03-07" }],
    filterExpr: 'parse_date(text, "YYYY-MM-DD") = "2024-03-07T00:00:00Z"',
  },
  {
    description: "parse_date(text, \"YYYY-MM-DD HH:mm:ss\") — full datetime format",
    seedRows: [{ text: "2024-03-07 15:42:33" }],
    filterExpr: 'parse_date(text, "YYYY-MM-DD HH:mm:ss") = "2024-03-07T15:42:33Z"',
  },
  {
    description: "is_null(parse_date(text, format)) on an out-of-range field (month 13) — bounds-checked to NULL, not an error",
    seedRows: [{ text: "2024-13-01" }],
    filterExpr: 'is_null(parse_date(text, "YYYY-MM-DD"))',
  },
  {
    description: "is_null(parse_date(text, format)) on shape-mismatched input",
    seedRows: [{ text: "not-a-date" }],
    filterExpr: 'is_null(parse_date(text, "YYYY-MM-DD"))',
  },
  {
    description: "is_null(parse_date(text, format)) NULL-safety",
    seedRows: [{ text: null }],
    filterExpr: 'is_null(parse_date(text, "YYYY-MM-DD"))',
  },

  // parse_number — pushable on every dialect, reusing batch 4's
  // numeric-regex/overflow-guarded-cast machinery after separator
  // normalization.
  {
    description: 'parse_number(text) — default "." decimal separator, "," thousands separator',
    seedRows: [{ text: "1,234.5" }],
    filterExpr: "parse_number(text) = 1234.5",
  },
  {
    description: 'parse_number(text, ",") — euro-style decimal separator swaps the roles ("." becomes the thousands separator)',
    seedRows: [{ text: "1.234,5" }],
    filterExpr: 'parse_number(text, ",") = 1234.5',
  },
  {
    description: "is_null(parse_number(text)) — scientific notation is explicitly rejected, not parsed",
    seedRows: [{ text: "1e10" }],
    filterExpr: "is_null(parse_number(text))",
  },
  {
    description: "is_null(parse_number(text)) on non-numeric input",
    seedRows: [{ text: "abc" }],
    filterExpr: "is_null(parse_number(text))",
  },
  {
    description: "is_null(parse_number(text)) NULL-safety",
    seedRows: [{ text: null }],
    filterExpr: "is_null(parse_number(text))",
  },

  // Phase 8b-3 — onFailure policy, live 4-evaluator coverage. All 4 cases
  // use the same computed_field(y = to_number(x)) shape with the same
  // valid/invalid/NULL seed so the only thing varying across them is the
  // onFailure policy (or, for the 4th, an aggregate step downstream of a
  // "drop" computed_field). computed_field, not filter, is deliberately
  // chosen for the fail/null/drop trio: filter's null and drop policies
  // collapse into the identical observable behavior (see OnFailurePolicy's
  // doc comment in nodeConfig.ts), which would make two of the three cases
  // indistinguishable; computed_field's null (field becomes NULL, row
  // stays) vs drop (row removed) are genuinely different code paths.
  {
    // A second computed_field column, `z = coalesce(to_number(x), 0)`, is
    // added here (follow-up item 2) specifically to prove the "handled"
    // exclusion holds live, not just in unit tests: to_number is directly
    // wrapped by coalesce, so it's excluded from the failure predicate —
    // no report entry for `z`, no abort, and (left with onFailure absent,
    // i.e. the "fail" default) still fully pushable across all 3 dialects,
    // since fallibleStepIsPushable only forces residual for an UNHANDLED
    // fallible call under "fail"/"quarantine".
    //
    // Phase 9 close-out follow-up: a third computed_field column,
    // `w = coalesce(parse_date(note, "YYYY-MM-DD"), parse_date(note,
    // "MM/DD/YYYY"))`, proves the refined coalesce rule live: unlike `z`
    // above, `w`'s LAST argument is itself a fallible call, so the whole
    // coalesce becomes one compound fallible unit instead of being
    // exempt — it fails on `note: "not-a-date"` (non-null input, matches
    // neither format, coalesce result NULL) but not on rows matching
    // either format.
    description: 'Phase 8b-3 — onFailure: "null" on computed_field(to_number(x)): failing row keeps its place with a NULL, count=1. Also carries a coalesce(to_number(x), 0)-handled column (z) with no explicit onFailure, proving a handled fallible call is excluded from the failure report and stays pushable under the "fail" default. Phase 9 follow-up: also carries a two-format coalesce(parse_date(note, f1), parse_date(note, f2)) column (w) whose fallible last argument makes the coalesce itself one compound fallible unit — it fails on a value matching neither format.',
    seedRows: [
      { x: "10", note: "2024-01-15" }, // valid -> y = 10, z = 10, not a failure; note matches format 1 -> w not a failure
      { x: "abc", note: "01/15/2024" }, // non-null arg, NULL result -> a failure for y; z = coalesce(NULL, 0) = 0, not a failure (handled); note matches format 2 -> w not a failure
      { x: null, note: "not-a-date" }, // NULL arg -> NOT a failure, y = NULL, z = coalesce(NULL, 0) = 0; note matches neither format, non-null input -> w IS a failure
    ],
    filterExpr: "to_number(x) > -1", // unused (steps set below), required by the type
    steps: [
      { kind: "computed_field", name: "y", expression: parseExpr("to_number(x)"), onFailure: "null" },
      { kind: "computed_field", name: "z", expression: parseExpr("coalesce(to_number(x), 0)") },
      {
        kind: "computed_field",
        name: "w",
        expression: parseExpr('coalesce(parse_date(note, "YYYY-MM-DD"), parse_date(note, "MM/DD/YYYY"))'),
        onFailure: "null",
      },
    ],
    tag: "onfailure",
    expectedResidualFailures: [
      { label: 'computed_field "y"', fns: ["to_number"], count: 1 },
      { label: 'computed_field "w"', fns: ["coalesce"], count: 1 },
    ],
  },
  {
    description: 'Phase 8b-3 / Phase 9 Part 4 — onFailure: "drop" on computed_field(to_number(x)): failing row is removed entirely, count=1; stays PUSHED (residualCount 0), and the live pushed pre-check reports the same count the residual arm does.',
    seedRows: [
      { x: "10" },
      { x: "abc" },
      { x: null },
    ],
    filterExpr: "to_number(x) > -1",
    steps: [{ kind: "computed_field", name: "y", expression: parseExpr("to_number(x)"), onFailure: "drop" }],
    tag: "onfailure",
    expectedResidualFailures: [{ label: 'computed_field "y"', fns: ["to_number"], count: 1 }],
    expectedPushedResidualCount: 0,
    expectedPreCheckFailures: [{ label: 'computed_field "y"', fns: ["to_number"], count: 1 }],
  },
  {
    description: 'Phase 8b-3 / Phase 9 Part 4 — onFailure: "fail" on computed_field(to_number(x)): the step now stays PUSHED (residualCount 0) on all 3 dialects, since only "quarantine" forces residual (fallibleStepIsPushable) — the residual arm still independently aborts naming the step/function/count (its pure in-process semantics are unaffected by pushability), and the live pushed pre-check (compileFailurePreChecks + buildFailurePreCheckQuery, the exact pair runEtl.ts calls) reports the same failing-row count that drives a real run\'s abort-before-any-write.',
    seedRows: [
      { x: "10" },
      { x: "abc" },
      { x: null },
    ],
    filterExpr: "to_number(x) > -1",
    steps: [{ kind: "computed_field", name: "y", expression: parseExpr("to_number(x)"), onFailure: "fail" }],
    tag: "onfailure",
    expectAbort: 'computed_field "y": to_number failed on 1 row(s).',
    expectedPushedResidualCount: 0,
    expectedPreCheckFailures: [{ label: 'computed_field "y"', fns: ["to_number"], count: 1 }],
  },
  {
    // A `filter` step, not `computed_field`, is required here:
    // aggregate.ts's pushdownPrefixRequirement only allows a pushed
    // aggregate to be preceded, in the pushed prefix, by `filter` steps
    // (a pushed computed_field ahead of it would need a subquery/CTE this
    // v1 compiler never emits, unrelated to onFailure — see its doc
    // comment). `y > -1` excludes both a failing row (to_number -> NULL,
    // three-valued NULL > -1 -> unknown -> excluded) and would exclude it
    // identically whether onFailure is "null" or "drop" (the two collapse
    // for filter, per OnFailurePolicy's doc comment) — onFailure: "drop"
    // is set anyway so this case genuinely exercises the policy's pushdown
    // path (fallibleStepIsPushable), not just a coincidental default.
    description: 'Phase 8b-3 — onFailure: "drop" on a filter step upstream of an aggregate: fully pushed down (WHERE excludes the failing row before GROUP BY), matching residual drop-then-aggregate',
    // `y` is a genuinely numeric seed column, summed by the aggregate —
    // kept separate from `x` (the fallible-filtered column) so this case
    // isolates the drop-before-GROUP-BY pushdown behavior from an
    // unrelated cross-dialect SUM(text) inconsistency (mysql implicitly
    // casts a numeric-looking string column, postgres errors outright
    // with "function sum(text) does not exist", mongo silently sums it
    // as 0 — summing `x` itself made all three dialects disagree for
    // reasons that have nothing to do with onFailure).
    seedRows: [
      { grp: "a", x: "10", y: 100 },
      { grp: "a", x: "abc", y: 200 }, // to_number(x) fails -> row excluded before aggregation
      { grp: "b", x: "5", y: 50 },
    ],
    filterExpr: "to_number(x) > -1",
    steps: [
      { kind: "filter", expr: parseExpr("to_number(x) > -1"), onFailure: "drop" },
      { kind: "aggregate", groupBy: ["grp"], aggregations: [{ fn: "sum", field: "y", alias: "total" }] },
    ],
    tag: "onfailure",
    expectedResidualFailures: [{ label: "filter", fns: ["to_number"], count: 1 }],
    // Item 3 follow-up: pins that this composition stays FULLY pushed
    // (residualCount 0) under "drop" on all 3 dialects. Originally (Phase
    // 8b-3) a real run (runEtl.ts) reported NO failure count at all for a
    // fully-pushed "drop"/"null" composition — documented as a v1
    // trade-off, not a bug (see docs/decisions.md's 8b-3 entry). Phase 9
    // Part 4 resolved that gap: `expectedPreCheckFailures` below proves
    // the live pushed pre-check (compileFailurePreChecks +
    // buildFailurePreCheckQuery/dispatch, the exact pair runEtl.ts calls
    // before extraction) now reports the same count the residual arm
    // does, on a real DB, with the step still fully pushed.
    expectedPushedResidualCount: 0,
    expectedPreCheckFailures: [{ label: "filter", fns: ["to_number"], count: 1 }],
  },
  {
    // Phase 9 Part 4 test list — the one required adversarial live
    // pagination case: a 2-column GROUP BY, a HAVING referencing a param
    // (literal), a NULL group key, and string keys differing only by case
    // ("a"/"A") in the same group-by column, paged at size 2 (5 distinct
    // groups -> 3 pages) so a real multi-page resume (dbHarness.ts's
    // runPagedAggregateQuery, mirroring runEtl.ts's own per-chunk
    // SqlGroupKeyCursor threading) is actually exercised, not just a
    // single-page compile. The ordinary pairwise diffRows below (already
    // order-independent) is enough to assert "the exact group set": if any
    // pushed arm split, duplicated, or dropped a group across pages, or if
    // mysql's GROUP BY collapsed "a"/"A" into one group while
    // postgres/mongo/residual kept them separate, that shows up as a row
    // count / content mismatch against the other arms.
    //
    // CONFIRMED LIVE (initial run): mysql merged "a"/"A" into one group (4
    // groups, one "a"-keyed row with total 30) while postgres/mongo/residual
    // agreed with each other on 5 distinct groups — a real bug, not a shape
    // artifact (pagination itself was never the bug: all 4 evaluators
    // correctly walked every page with no dropped/duplicated group at their
    // own group count). FIXED in aggregate.ts's emitSql: mysql's GROUP
    // BY/ORDER BY column list is now BINARY-cast (byte-wise grouping/
    // ordering) with the SELECT-list groupBy columns wrapped in
    // ANY_VALUE(...) AS <col> to stay compatible with this sandbox's
    // ONLY_FULL_GROUP_BY sql_mode without corrupting the returned column
    // name — see that file's comment for the full rationale. Re-run live
    // after the fix: all 4 arms agree on 5 distinct groups, XPASS (no
    // divergence) — see docs/decisions.md's Phase 9 entry. Known residual
    // risk (not exercised by this case, which only has string groupBy
    // columns): the fix forces BINARY unconditionally on every mysql
    // groupBy column regardless of type, which would flip ORDER BY's sort
    // semantics for a NUMERIC groupBy column from numeric to
    // lexicographic-byte, while the WHERE-side group-key keyset cursor
    // comparison (compileCondition's Fix 1) stays numeric for that same
    // column — a theoretical duplicate/skipped-group pagination risk for a
    // numeric groupBy column, flagged as an open risk, not reproduced or
    // fixed here (out of this phase's scope).
    description: 'Phase 9 Part 4 — adversarial paginated aggregate: GROUP BY (g1, g2), HAVING total > 0 (param), a NULL group key, "a"/"A" case-differing group keys, page size 2',
    seedRows: [
      { g1: "a", g2: "x", v: 10 },
      { g1: "A", g2: "x", v: 20 },
      { g1: null, g2: "x", v: 5 },
      { g1: "b", g2: "y", v: 7 },
      { g1: "b", g2: "y", v: 3 },
      { g1: "c", g2: "z", v: 1 },
    ],
    filterExpr: "true",
    steps: [
      {
        kind: "aggregate",
        groupBy: ["g1", "g2"],
        aggregations: [{ fn: "sum", field: "v", alias: "total" }],
        having: parseExpr("total > 0"),
      },
    ],
    tag: "aggregate-pagination",
    expectedPushedResidualCount: 0,
    pageSize: 2,
  },
  {
    // Fix (numeric group keys under MySQL pagination) — the residual risk
    // flagged (and deliberately not reproduced/fixed) by the case above:
    // mysql's GROUP BY/ORDER BY forces byte-wise ordering on every groupBy
    // column regardless of type, so an INT groupBy column with values
    // 9/10/100 sorts as "10" < "100" < "9" (byte order), not 9 < 10 < 100
    // (numeric order). Page size 2 with 3 distinct groups forces a real
    // multi-page resume: page 1 (BINARY-ordered) returns the "10" and "100"
    // groups; the cursor becomes n=100. Pre-fix, the WHERE-side keyset
    // compared the cursor NUMERICALLY (`n > 100`), which is false for every
    // remaining group (9 is not > 100 numerically) — silently DROPPING the
    // n=9 group entirely. Fixed: the cursor is read from and compared
    // against the same HEX(BINARY n) byte-order encoding ORDER BY sorts
    // by, so `HEX(BINARY n) > HEX(BINARY '100')` correctly matches "9"
    // (byte-wise "9" > "100") and page 2 returns it.
    //
    // A second groupBy column, `d` (DECIMAL(10,2)), is included specifically
    // to prove the cursor is read from the hidden HEX(BINARY col) column,
    // never the plain returned value: mysql2 renders a DECIMAL(10,2) as a
    // JS STRING ("10.00"), not a number, so a cursor naively built from the
    // returned row would fail to even round-trip through a JSON-persisted
    // checkpoint, independently of the byte-order-vs-numeric-order issue
    // above.
    //
    // The ordinary pairwise diffRows below (order-independent) is enough to
    // assert "the exact group set": a dropped/duplicated group on any pushed
    // arm shows up as a row-count/content mismatch against the other 3 arms.
    // CONFIRMED LIVE: all 4 arms agree on the same 3 groups (n=9 total=3,
    // n=10 total=3, n=100 total=9) across both pages — no dropped/duplicated
    // group. The only per-row mismatch is `d`'s own JS type (mysql2 returns
    // "1.50" as a string; postgres/mongo/residual return 1.5 as a number) —
    // declared below via expectedDivergence, unrelated to pagination.
    description: "Fix — adversarial paginated aggregate: GROUP BY (n INT, d DECIMAL(10,2)) with n = 9, 10, 100 (byte order != numeric order), page size 2",
    seedRows: [
      { n: 9, d: 1.5, v: 1 },
      { n: 9, d: 1.5, v: 2 },
      { n: 10, d: 2.5, v: 3 },
      { n: 100, d: 3.5, v: 4 },
      { n: 100, d: 3.5, v: 5 },
    ],
    filterExpr: "true",
    steps: [
      {
        kind: "aggregate",
        groupBy: ["n", "d"],
        aggregations: [{ fn: "sum", field: "v", alias: "total" }],
      },
    ],
    decimalColumns: ["d"],
    tag: "aggregate-pagination-numeric",
    expectedPushedResidualCount: 0,
    pageSize: 2,
    expectedDivergence: {
      reason:
        'mysql renders the DECIMAL(10,2) groupBy column `d` as a JS string (e.g. "1.50"), while postgres/mongo/residual render it as a JS number (1.5) — a pre-existing mysql2 driver type-shape quirk, unrelated to pagination. The group SET itself (which `n` values exist, with correct `total` sums) agrees across all 4 evaluators on every page; only `d`\'s own JS type differs.',
      decisionsRef:
        "docs/decisions.md — \"Phase 9 close-out fix: MySQL group-key pagination cursor must match ORDER BY's byte order, not the column's own type\"",
    },
  },
];
