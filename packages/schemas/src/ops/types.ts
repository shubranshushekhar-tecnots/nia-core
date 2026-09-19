import type { z } from "zod";
import type { Expr } from "../expression.js";
import type {
  AggregationSpec,
  FilterCondition,
  TransformStep,
} from "../nodeConfig.js";

// ---- Dialects -----------------------------------------------------------
//
// Defined here (not in pushdown.ts) so both pushdown.ts and the op/adapter
// modules can depend on it without a circular runtime import. pushdown.ts
// re-exports these under their original names — its public API is
// unchanged.

export type SqlDialect = "mysql" | "postgres";
export type SourceDialect = SqlDialect | "mongo";

export type OpKind = TransformStep["kind"];

// ---- Dialect adapters (the HOW) -----------------------------------------

export interface SqlDialectAdapter {
  readonly dialect: SqlDialect;
  quoteIdent(name: string): string;
  placeholder(index: number): string;
  compileExpr(expr: Expr, params: unknown[]): string;
  compileCondition(cond: FilterCondition, params: unknown[]): string;
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
    params: unknown[],
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

// ---- Emit contexts (per-node accumulation, built by the orchestrator) ---

export interface SqlEmitContext {
  readonly adapter: SqlDialectAdapter;
  readonly params: unknown[];
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

  isPushable(dialect: SourceDialect): boolean;
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

  /** In-memory fallback (residualTransform.ts). */
  applyResidual(
    input: { cols: string[]; rows: Record<string, unknown>[] },
    step: TStep,
  ): { cols: string[]; rows: Record<string, unknown>[] };

  /**
   * Strict check-time validation (checks.ts checkConfig). Plain message
   * strings — the caller (checkConfig) wraps each into a CheckResult with
   * node/index context, same division as today.
   */
  checkConfig?(step: TStep, ctx: { index: number }): string[];
}
