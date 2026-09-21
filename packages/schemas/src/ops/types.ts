import type { z } from "zod";
import type { CallFn, Expr } from "../expression.js";
import { collectCallFns } from "../expression.js";
import type {
  AggregationSpec,
  FilterCondition,
  OnFailurePolicy,
  TransformStep,
} from "../nodeConfig.js";
import type { ParamSink } from "./paramSink.js";

// ---- Dialects -----------------------------------------------------------
//
// Defined here (not in pushdown.ts) so both pushdown.ts and the op/adapter
// modules can depend on it without a circular runtime import. pushdown.ts
// re-exports these under their original names — its public API is
// unchanged.

export type SqlDialect = "mysql" | "postgres";
export type SourceDialect = SqlDialect | "mongo";

export type OpKind = TransformStep["kind"];

// ---- Per-call-function pushability (the WHAT, at expression-node grain) --
//
// Phase 8b-2, batch 0: `isPushable(dialect, step)` below needs to know,
// for a specific step's Expr tree, whether every call-fn it uses is
// pushable on a given dialect — not just whether the op *kind* is
// structurally pushable there. Kept as ONE inspectable data table (not
// per-function branches scattered across filter.ts/computedField.ts/
// aggregate.ts) because the profiler, the future function-vocabulary
// specialists, and eventually the plan compiler all need to consult the
// same source of truth. Every entry in expression.ts's `CallFn` union
// must have a row here — TypeScript's `Record<CallFn, ...>` enforces
// that at compile time (a missing key is a type error, not a silent
// runtime gap).
export const FN_PUSHABILITY: Record<CallFn, Record<SourceDialect, boolean>> = {
  concat: { mysql: true, postgres: true, mongo: true },
  coalesce: { mysql: true, postgres: true, mongo: true },
  contains: { mysql: true, postgres: true, mongo: true },
  is_null: { mysql: true, postgres: true, mongo: true },
  is_not_null: { mysql: true, postgres: true, mongo: true },
  is_number: { mysql: true, postgres: true, mongo: true },
  is_text: { mysql: true, postgres: true, mongo: true },
  looks_numeric: { mysql: true, postgres: true, mongo: true },
  // Phase 8b-2, batch 1: Math core. All 15 are expressible on every
  // dialect — see docs/decisions.md's batch 1 entry for the per-function
  // emission strategy (several are implemented via an explicit formula
  // rather than a native SQL/Mongo primitive specifically to avoid a
  // cross-dialect semantic divergence, not because the primitive is
  // missing on some dialect).
  divide: { mysql: true, postgres: true, mongo: true },
  round: { mysql: true, postgres: true, mongo: true },
  round_up: { mysql: true, postgres: true, mongo: true },
  round_down: { mysql: true, postgres: true, mongo: true },
  abs: { mysql: true, postgres: true, mongo: true },
  ceil: { mysql: true, postgres: true, mongo: true },
  floor: { mysql: true, postgres: true, mongo: true },
  round_to_multiple: { mysql: true, postgres: true, mongo: true },
  mod: { mysql: true, postgres: true, mongo: true },
  power: { mysql: true, postgres: true, mongo: true },
  sqrt: { mysql: true, postgres: true, mongo: true },
  sign: { mysql: true, postgres: true, mongo: true },
  quotient: { mysql: true, postgres: true, mongo: true },
  int: { mysql: true, postgres: true, mongo: true },
  trunc: { mysql: true, postgres: true, mongo: true },
  // Phase 8b-2, batch 2: Math remainder. All 3 expressible on every
  // dialect (mysql/postgres native EXP/LN/LOG, mongo native
  // $exp/$ln/$log) — see docs/decisions.md's batch 2 entry for the
  // pinned zero/negative-input NULL contract each evaluator implements.
  exp: { mysql: true, postgres: true, mongo: true },
  ln: { mysql: true, postgres: true, mongo: true },
  log: { mysql: true, postgres: true, mongo: true },
  // Phase 8b-2, batch 3: DAX-derived Text core (+ split). 9 of 11
  // expressible on every dialect — see docs/decisions.md's batch 3 entry
  // for the per-function contract (empty-needle/negative-n/out-of-range
  // clamps etc.) and its live-verification grounding of every divergence
  // it homogenizes by construction (postgres's LEFT/RIGHT/SUBSTRING
  // negative-n semantics, mongo's $replaceAll empty-find behavior, mongo's
  // $split empty-separator error). upper/lower are the batch's one genuine
  // impossibility: verified live that Mongo's $toUpper/$toLower only
  // transform ASCII a-z/A-Z (no Unicode-aware case folding operator exists
  // in its aggregation pipeline), diverging from mysql/postgres's
  // collation-aware full-Unicode case mapping — mongo:false here, residual
  // (JS String#toUpperCase/toLowerCase, already full-Unicode) is used
  // instead. See mongo.ts's compileTextFnMongo doc comment.
  upper: { mysql: true, postgres: true, mongo: false },
  lower: { mysql: true, postgres: true, mongo: false },
  trim: { mysql: true, postgres: true, mongo: true },
  left: { mysql: true, postgres: true, mongo: true },
  right: { mysql: true, postgres: true, mongo: true },
  mid: { mysql: true, postgres: true, mongo: true },
  len: { mysql: true, postgres: true, mongo: true },
  substitute: { mysql: true, postgres: true, mongo: true },
  find: { mysql: true, postgres: true, mongo: true },
  rept: { mysql: true, postgres: true, mongo: true },
  split: { mysql: true, postgres: true, mongo: true },
  // Phase 8b-2, batch 4: Coercion vocabulary (`exact` proposed, dropped —
  // see expression.ts's ExprCall doc comment and docs/decisions.md's
  // batch 4 entry). All 6 expressible on every dialect. Correction: an
  // earlier draft of this comment claimed no native CAST/$convert/
  // $toString primitive is used anywhere — inaccurate once actually
  // implemented. CAST(text AS DOUBLE)/$toDouble IS used for the final
  // numeric parse (a hand-rolled arithmetic parser would be impractically
  // fragile), but only ever on a value already regex-validated against a
  // shared numeric pattern and overflow-guarded by magnitude/length
  // BEFORE reaching the native cast — sidestepping every native
  // overflow-error/silent-clamp divergence found live (mysql clamps,
  // postgres errors, mongo's $toDouble errors) by never letting an
  // out-of-range value reach it. The decimal-formatting half (to_text/
  // format_number) is still built from primitive arithmetic (FLOOR/POWER/
  // $floor/$pow) rather than native FORMAT/to_char/$toString-of-a-double,
  // since those diverge on locale/rounding mode (verified live, same
  // reasoning as batch 1's round()).
  to_number: { mysql: true, postgres: true, mongo: true },
  to_integer: { mysql: true, postgres: true, mongo: true },
  to_text: { mysql: true, postgres: true, mongo: true },
  format_number: { mysql: true, postgres: true, mongo: true },
  to_boolean: { mysql: true, postgres: true, mongo: true },
  to_date: { mysql: true, postgres: true, mongo: true },
  // Phase 8b-2, batch 5: Date-part vocabulary. All 10 expressible on
  // every dialect — see sqlShared.ts's compileDateCoerceSql (type-driven
  // coercion: a real typed date/timestamp/timestamptz column casts
  // directly, an ISO-8601-shaped string casts after validation, anything
  // else resolves to NULL) and mongo.ts's compileDateFnMongo ($convert
  // with onError/onNull:null, the mongo-side equivalent) for the shared
  // coercion contract every one of these 10 functions relies on. See
  // docs/decisions.md's batch 5 entry for the ISO-8601/ISO-weekday
  // (Mon=1..Sun=7)/UTC-everywhere pins, and date_diff/date_add's
  // truncation and month-end-clamp contracts.
  year: { mysql: true, postgres: true, mongo: true },
  month: { mysql: true, postgres: true, mongo: true },
  day: { mysql: true, postgres: true, mongo: true },
  hour: { mysql: true, postgres: true, mongo: true },
  minute: { mysql: true, postgres: true, mongo: true },
  second: { mysql: true, postgres: true, mongo: true },
  quarter: { mysql: true, postgres: true, mongo: true },
  weekday: { mysql: true, postgres: true, mongo: true },
  date_diff: { mysql: true, postgres: true, mongo: true },
  date_add: { mysql: true, postgres: true, mongo: true },
  // Phase 8b-2, batch 6: Cleaning vocabulary. Mixed pushability — see
  // sqlShared.ts's compileCleanFnSql and mongo.ts's compileCleanFnMongo
  // doc comments for the full per-function construction strategy, and
  // docs/decisions.md's batch 6 entry for the live-verification grounding.
  // regex_match: native REGEXP_LIKE/~ (mysql/postgres) and $regexMatch
  // (mongo) on every dialect.
  regex_match: { mysql: true, postgres: true, mongo: true },
  // regex_extract: mysql:false — REGEXP_SUBSTR has no capture-group-index
  // parameter (verified via docs), so a specific numbered group can't be
  // extracted natively. postgres:true via regexp_match(...)[group] (whole-
  // match group 0 via an outer-paren-wrap + substring(... from ...) trick).
  // mongo:true via $regexFind's captures array (genuinely pushable there,
  // unlike mysql).
  regex_extract: { mysql: false, postgres: true, mongo: true },
  // regex_replace: mysql/postgres true (REGEXP_REPLACE/regexp_replace,
  // with a compile-time backslash-N-to-ICU-$N replacement-syntax
  // translation on mysql only — see compileCleanFnSql doc comment).
  // mongo:false — no regex-based replace pipeline operator exists at all
  // (only literal-substring $replaceOne/$replaceAll).
  regex_replace: { mysql: true, postgres: true, mongo: false },
  // canonicalize: mysql/postgres true via REGEXP_REPLACE-based whitespace-
  // run collapse + border-trim. mongo:false — same missing regex-replace
  // primitive as regex_replace; a $reduce-based construction was judged
  // materially riskier than falling back to residual.
  canonicalize: { mysql: true, postgres: true, mongo: false },
  // strip_accents: false everywhere — no dialect exposes a native
  // NFD-normalize + strip-combining-marks primitive; always residual.
  strip_accents: { mysql: false, postgres: false, mongo: false },
  // parse_date: true everywhere via a from-scratch, native-parser-avoiding
  // construction (compile-time format-token-offset extraction + explicit
  // bounds-checking, never STR_TO_DATE/TO_TIMESTAMP/mongo's date parser)
  // — deliberately sidesteps uncertainty about whether a native parser
  // ERRORs vs returns NULL on out-of-range fields, since a hard error
  // would abort the whole query.
  parse_date: { mysql: true, postgres: true, mongo: true },
  // parse_number: true everywhere via SQL-level/aggregation-level
  // separator normalization + numeric-regex validation + overflow-guarded
  // native double cast (same battle-tested pattern as batch 4's
  // to_number).
  parse_number: { mysql: true, postgres: true, mongo: true },
};

/** True iff every call-fn used anywhere in `expr` is pushable on `dialect` per FN_PUSHABILITY — the shared check filter/computed_field/aggregate's isPushable delegate to, so a single unsupported function inside an otherwise-pushable expression correctly falls the whole step back to residual rather than emitting wrong/partial SQL or a pipeline stage. */
export function exprFnsPushable(expr: Expr, dialect: SourceDialect): boolean {
  for (const fn of collectCallFns(expr)) {
    if (!FN_PUSHABILITY[fn][dialect]) return false;
  }
  return true;
}

// ---- Dialect adapters (the HOW) -----------------------------------------

export interface SqlDialectAdapter {
  readonly dialect: SqlDialect;
  /** Throws if `name` contains PARAM_TOKEN_CHAR (paramSink.ts) — a customer-controlled identifier must never be able to smuggle a ParamSink token into emitted SQL text. See paramSink.ts's doc comment. */
  quoteIdent(name: string): string;
  placeholder(index: number): string;
  compileExpr(expr: Expr, params: ParamSink): string;
  compileCondition(cond: FilterCondition, params: ParamSink): string;
  /**
   * Applies cond's operator+value against an already-resolved target SQL
   * expression instead of quoteIdent(cond.field) — the aggregate op's
   * HAVING re-embed case (HAVING can't portably reference a SELECT alias
   * across mysql/postgres). Not on MongoDialectAdapter: by the time
   * $match runs, $project has already flattened groupBy/alias fields to
   * top-level keys, so plain compileCondition is always sufficient there.
   */
  compileConditionAgainstTarget(
    target: string,
    cond: FilterCondition,
    params: ParamSink,
  ): string;
  compileAggAccumulator(agg: AggregationSpec): string;
  /** null when given zero fragments (caller omits the clause entirely). */
  combineAnd(fragments: string[]): string | null;
}

export interface MongoDialectAdapter {
  readonly dialect: "mongo";
  compileExpr(expr: Expr): unknown;
  compileCondition(cond: FilterCondition): Record<string, unknown>;
  compileAggAccumulator(agg: AggregationSpec): unknown;
  combineAnd(clauses: Record<string, unknown>[]): Record<string, unknown> | null;
}

// ---- Failure reporting (Phase 8b-3) ---------------------------------------
//
// "fail" and "quarantine" are always forced residual whenever a step's
// expression actually contains a fallible call (expression.ts's
// FALLIBLE_CALL_FNS) — see onFailure.ts's top doc comment for why. That
// means no pushed-SQL/Mongo flag-column mechanism is needed at all: only a
// residually executed step ever counts failures. "null"/"drop" still push
// normally but don't get a failure count (documented v1 trade-off — see
// onFailure.ts).

export interface StepFailureReport {
  /** Human-readable step identity for the abort error, e.g. `computed_field "discount"`. */
  label: string;
  fns: CallFn[];
  policy: OnFailurePolicy;
  count: number;
}

// ---- Emit contexts (per-node accumulation, built by the orchestrator) ---

export interface SqlEmitContext {
  readonly adapter: SqlDialectAdapter;
  readonly params: ParamSink;
  addWhere(fragment: string): void;
  addSelect(fragment: string): void;
  /**
   * Aggregate-only: REPLACES the select list (full-replacement semantics)
   * and sets GROUP BY/HAVING. splitPushable's blocksFollowingPushdown
   * guarantees this is called at most once per compile.
   */
  setAggregate(select: string[], groupBy: string[] | null, having: string | null): void;
}

export interface MongoEmitContext {
  readonly adapter: MongoDialectAdapter;
  push(stage: Record<string, unknown>): void;
  markAggregate(): void;
}

// ---- Op module (the WHAT) ------------------------------------------------

export interface OpModule<TStep extends TransformStep = TransformStep> {
  readonly kind: TStep["kind"];
  /**
   * Input type intentionally loosened to `any`: zod's `.default(...)` makes
   * a schema's actual parse-input type (pre-default) narrower/optional
   * compared to its parsed Output (TStep) — pinning the 3rd ZodType
   * generic to TStep here would reject every real op schema (they all use
   * `.default([])` on array fields). Output stays pinned to TStep, which
   * is what every caller of `.schema.parse(...)` actually relies on.
   */
  readonly schema: z.ZodType<TStep, z.ZodTypeDef, any>;
  /** The empty/just-added step shape (TransformEditor's addStep ternary today). */
  createDefault(): TStep;

  /**
   * Phase 8b-2, batch 0: widened to take `step` alongside `dialect` so an
   * op can inspect its own Expr tree(s) — e.g. via exprFnsPushable above —
   * and declare itself non-pushable on a dialect because of a specific
   * call-fn it contains, not just because of the op kind in general.
   * Ops with no Expr content (drop_fields) or whose Expr's fn-pushability
   * doesn't vary (aggregate's groupBy/aggregations, which never contain
   * call-fns) can ignore `step` and answer purely from `dialect`, same as
   * before this widening.
   */
  isPushable(dialect: SourceDialect, step: TStep): boolean;
  /**
   * Constrains where in the pushed prefix this op may land, given the
   * kinds already pushed ahead of it on this node. Absent = always true.
   * (aggregate: every prior pushed kind must be "filter".)
   */
  pushdownPrefixRequirement?(pushedKindsSoFar: OpKind[]): boolean;
  /**
   * True if pushing this op must block every later step from pushing too.
   * Absent = false. (aggregate: true — GROUP BY collapses row identity.)
   */
  blocksFollowingPushdown?: boolean;

  /** Absent for ops never SQL-pushable (drop_fields). */
  emitSql?(step: TStep, ctx: SqlEmitContext): void;
  /** Absent for ops never Mongo-pushable (none today — all 4 are). */
  emitMongo?(step: TStep, ctx: MongoEmitContext): void;

  /** Mirrors transformOutputFields' per-kind branch. Absent = shape unchanged. */
  transformOutputShape?(step: TStep, currentShape: Set<string> | null): Set<string> | null;

  /**
   * In-memory fallback (residualTransform.ts). `failures` (Phase 8b-3) is
   * optional and omitted entirely by ops whose step type can never carry a
   * fallible call (drop_fields) — present (possibly empty-count) on
   * filter/computed_field/aggregate whenever their expression contains a
   * fallible call, so runEtl.ts can report/abort the same way regardless
   * of which step ran residually.
   */
  applyResidual(
    input: { cols: string[]; rows: Record<string, unknown>[] },
    step: TStep,
  ): { cols: string[]; rows: Record<string, unknown>[]; failures?: StepFailureReport[] };

  /**
   * Strict check-time validation (checks.ts checkConfig). Plain message
   * strings — the caller (checkConfig) wraps each into a CheckResult with
   * node/index context, same division as today.
   */
  checkConfig?(step: TStep, ctx: { index: number }): string[];
}
