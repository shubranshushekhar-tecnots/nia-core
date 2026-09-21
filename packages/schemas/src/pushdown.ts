import type { TransformConfig, TransformStep } from "./nodeConfig.js";
import type { MongoDialectAdapter, OpKind, SqlDialectAdapter, SqlEmitContext, MongoEmitContext } from "./ops/types.js";
import { opForStep } from "./ops/registry.js";
import { mysqlAdapter } from "./ops/dialects/mysql.js";
import { postgresAdapter } from "./ops/dialects/postgres.js";
import { mongoAdapter } from "./ops/dialects/mongo.js";
import { createParamSink, resolveParamSink } from "./ops/paramSink.js";

/**
 * Compiler pushdown v1 — pure, no I/O, importable by both apps/worker
 * (Phase 6 execution, not wired this session) and apps/web (this session's
 * transform-drawer transparency preview: "pushed down: N · in-stream: M" +
 * a copyable fragment). Lives in packages/schemas (not packages/guardrails)
 * deliberately: guardrails is validation of untrusted *executed* SQL/Mongo
 * text and is explicitly server-only (see no-web-import.test.ts) — this
 * module only ever *generates* parameterized fragments from a node's own
 * TransformConfig, which is safe and meant to be shown to the user.
 *
 * Scope: this compiles a FRAGMENT (a WHERE clause / extra SELECT
 * expressions / params for SQL, a partial aggregation pipeline for Mongo),
 * not a full runnable statement — this stays true even after Phase 6 Block 0
 * added `SourceDestConfig.entity` (nodeConfig.ts): resolving *which*
 * table/collection is a separate concern (entityResolution.ts's
 * findPersistedEntity/resolveSourceEntity, called by runPreview.ts/Phase 6's
 * executor) from compiling *what to do* against it, and this module still
 * has no reason to take a FROM target as input. Callers splice this
 * fragment into a query they build themselves once they've already resolved
 * the entity — see runPreview.ts's buildPreviewQuery for the reference
 * pattern (resolve entity first, call compilePushdown for the fragment,
 * combine both into the runnable statement).
 *
 * Steps apply in array order (TransformConfig.steps' own ordering
 * contract). Pushdown walks that order and accumulates into the compiled
 * query for as long as each step is pushable to the target dialect; the
 * FIRST non-pushable step, and everything after it, becomes residual
 * in-stream work — matching how a streaming executor actually has to fall
 * back once it can no longer extend the pushed-down query (a later step
 * could in principle still push down on its own, but reordering
 * user-authored transform steps around a residual step would silently
 * change semantics, so this compiler never does that).
 *
 * Phase 8a: the per-op if/switch chains that used to live directly in this
 * file (isPushable/splitPushable/compileSql/compileMongo/
 * transformOutputFields) are now thin loops over OP_REGISTRY
 * (ops/registry.ts) — each op module owns its own pushability, ordering
 * constraints, and SQL/Mongo emission. Dialect-specific primitives
 * (identifier quoting, placeholders, expression/condition/accumulator
 * compilation) live on a DialectAdapter per dialect (ops/dialects/*) — op
 * modules describe WHAT to emit, adapters decide HOW. Behavior-preserving:
 * this file's public exports/shapes are unchanged.
 */

export type { SqlDialect, SourceDialect } from "./ops/types.js";
import type { SourceDialect, SqlDialect } from "./ops/types.js";

/** manifest.ts's 3 shipped connector ids -> the dialect their /execute endpoint speaks. Unknown/future manifests return null (nothing pushable). */
export function manifestDialect(manifestId: string | undefined): SourceDialect | null {
  if (manifestId === "mysql") return "mysql";
  if (manifestId === "supabase") return "postgres";
  if (manifestId === "mongodb") return "mongo";
  return null;
}

export type SqlDialectQuery = {
  dialect: SqlDialect;
   /** AND-joined condition fragment, e.g. `("age" > $1 AND "name" = $2)`. Null when no filter step was pushable. */
  whereSql: string | null;
  /**
   * Comma-joined `expr AS "alias"` fragments. When `isAggregate` is false
   * (the pre-Block-6 shape) this is an ADDITIVE list — the caller splices it
   * onto `SELECT *, ...` alongside every other column (see queryBuilder.ts).
   * When `isAggregate` is true this becomes the FULL REPLACEMENT select list
   * (groupBy columns + aggregation expressions only) — GROUP BY collapses
   * row identity, so there is no `*` to additively select alongside it; the
   * caller must use this as the entire SELECT clause, not splice it onto one.
   */
  selectSql: string | null;
  /** Positional params in emission order — mysql binds by `?`, postgres by `$n`; both are represented as a plain ordered array here, the executor binds per its own driver. */
  params: unknown[];
  /**
   * True when a pushed `aggregate` step produced this query (Phase 6 Block
   * 6). Callers (queryBuilder.ts's buildEtlReadQuery) must branch on this:
   * an aggregate query is never keyset-paginated (GROUP BY collapses the
   * source primary key that pagination cursors on), so it runs as a single
   * non-paginated statement instead, capped by LIMIT at the executor's
   * MAX_CHUNK_ROWS — a real, disclosed v1 limitation (see TODO.md), not an
   * oversight.
   */
  isAggregate: boolean;
  /** Comma-joined, quoted groupBy column list, e.g. `"cohort", "region"`. Null for a whole-table aggregate (empty groupBy) or when isAggregate is false. */
  groupBySql: string | null;
  /** AND-joined HAVING fragment, referencing aggregation aliases (bare, re-embedded expressions) or groupBy columns per ruling 2 — never a raw pre-aggregate column. Null when no `having` was configured or isAggregate is false. */
  havingSql: string | null;
};

export type MongoDialectQuery = {
  dialect: "mongo";
  pipeline: Record<string, unknown>[];
  /** See SqlDialectQuery.isAggregate — same non-pagination consequence applies to the Mongo pipeline (buildEtlReadQuery appends only `$limit`, no `$match(cursor)`/`$sort` keyset stages). */
  isAggregate: boolean;
};

export type DialectQuery = SqlDialectQuery | MongoDialectQuery;

export type PushdownPlan = {
  dialectQuery: DialectQuery | null;
  residualTransforms: TransformStep[];
  pushedDownCount: number;
  residualCount: number;
};

function sqlAdapterFor(dialect: SqlDialect): SqlDialectAdapter {
  return dialect === "mysql" ? mysqlAdapter : postgresAdapter;
}

/**
 * Splits steps into a pushed-down prefix and a residual suffix, in original
 * order (order-stopping semantics — see this file's header comment).
 *
 * Generic over every op's own `pushdownPrefixRequirement`/
 * `blocksFollowingPushdown` hooks (ops/types.ts) instead of hand-written
 * per-kind flags — today only `aggregate` declares either hook (it may only
 * be preceded, in the pushed prefix, by `filter` steps, and blocks every
 * later step from pushing once it lands), but any future op can express the
 * same kind of ordering constraint without this function changing.
 */
function splitPushable(steps: TransformStep[], dialect: SourceDialect): { pushed: TransformStep[]; residual: TransformStep[] } {
  const pushed: TransformStep[] = [];
  const residual: TransformStep[] = [];
  const pushedKinds: OpKind[] = [];
  let blocked = false;
  for (const step of steps) {
    if (blocked) {
      residual.push(step);
      continue;
    }
    const op = opForStep(step);
    const prefixOk = op.pushdownPrefixRequirement ? op.pushdownPrefixRequirement(pushedKinds) : true;
    if (!prefixOk || !op.isPushable(dialect, step)) {
      blocked = true;
      residual.push(step);
      continue;
    }
    pushed.push(step);
    pushedKinds.push(step.kind);
    if (op.blocksFollowingPushdown) blocked = true;
  }
  return { pushed, residual };
}

// ---- SQL compilation -------------------------------------------------

function compileSql(steps: TransformStep[], dialect: SqlDialect): SqlDialectQuery {
  const adapter = sqlAdapterFor(dialect);
  // Phase 8b-2 Follow-up 1 (arg(n)/params desync hardening — see
  // ops/paramSink.ts's doc comment for the full story): every step's
  // emitSql pushes its literals onto this ParamSink as opaque TOKENS, not
  // real placeholders yet — resolveParamSink below is the ONE place,
  // after every fragment is fully assembled, that swaps tokens for real
  // placeholders, walked in REAL SQL clause/physical order rather than
  // JS-call order.
  const sink = createParamSink();
  const whereFragments: string[] = [];
  const selectFragments: string[] = [];
  let aggregateResult: { select: string[]; groupBy: string[] | null; having: string | null } | null = null;

  const ctx: SqlEmitContext = {
    adapter,
    params: sink,
    addWhere(fragment) {
      whereFragments.push(fragment);
    },
    addSelect(fragment) {
      selectFragments.push(fragment);
    },
    setAggregate(select, groupBy, having) {
      aggregateResult = { select, groupBy, having };
    },
  };

  for (const step of steps) {
    opForStep(step).emitSql?.(step, ctx);
  }

  const whereJoined = adapter.combineAnd(whereFragments);

  if (!aggregateResult) {
    const selectJoined = selectFragments.length ? selectFragments.join(", ") : null;
    // Physical order matches queryBuilder.ts's real assembly: `SELECT *, <selectSql> FROM ... WHERE <whereSql>` — select before where.
    const { resolved, params } = resolveParamSink(
      sink,
      [selectJoined, whereJoined] as [string | null, string | null],
      adapter.placeholder,
    );
    const [selectSql, whereSql] = resolved;
    return { dialect, whereSql, selectSql, params, isAggregate: false, groupBySql: null, havingSql: null };
  }

  const { select, groupBy, having } = aggregateResult as { select: string[]; groupBy: string[] | null; having: string | null };
  const selectJoined = select.length ? select.join(", ") : null;
  const groupByJoined = groupBy && groupBy.length ? groupBy.join(", ") : null;
  // Physical order matches queryBuilder.ts's real assembly: `SELECT <selectSql> FROM ... WHERE <whereSql> GROUP BY <groupBySql> HAVING <havingSql>`.
  const { resolved, params } = resolveParamSink(
    sink,
    [selectJoined, whereJoined, groupByJoined, having] as [string | null, string | null, string | null, string | null],
    adapter.placeholder,
  );
  const [selectSql, whereSql, groupBySql, havingSql] = resolved;
  return { dialect, whereSql, selectSql, params, isAggregate: true, groupBySql, havingSql };
}

// ---- Mongo compilation -------------------------------------------------

function compileMongo(steps: TransformStep[]): MongoDialectQuery {
  const pipeline: Record<string, unknown>[] = [];
  let isAggregate = false;

  const ctx: MongoEmitContext = {
    adapter: mongoAdapter,
    push(stage) {
      pipeline.push(stage);
    },
    markAggregate() {
      isAggregate = true;
    },
  };

  for (const step of steps) {
    opForStep(step).emitMongo?.(step, ctx);
  }

  return { dialect: "mongo", pipeline, isAggregate };
}

/**
 * Computes the field-name SHAPE (not values) a TransformConfig's steps
 * produce, mirroring the full-replacement semantics compileSql/
 * compileMongoAggregate use for a pushed aggregate step (see
 * SqlDialectQuery.selectSql's doc comment above): once an `aggregate` step
 * applies, row identity collapses to exactly its `groupBy` columns +
 * `aggregations[].alias` — none of the pre-aggregate source columns survive
 * into the result set. Steps after the aggregate can still narrow that new
 * shape (`drop_fields`) or add to it (`computed_field`, e.g. a residual
 * ratio over two sibling aggregation aliases — ruling 1); `filter` never
 * changes field shape. Returns null when the config has no aggregate step
 * at all, so callers keep using the raw upstream/introspected field list —
 * unchanged, pre-Block-6 behavior.
 *
 * Consumed by MappingEditor.tsx's field-mapping dropdown (wired in by
 * NodeDrawer.tsx via findUpstreamSource's transformConfigs) so a
 * destination fed by an Aggregate transform maps from the aggregate's
 * actual output field names instead of raw source columns that no longer
 * exist in the query once GROUP BY has run.
 */
export function transformOutputFields(config: TransformConfig): string[] | null {
  let fields: Set<string> | null = null;
  for (const step of config.steps) {
    const op = opForStep(step);
    if (op.transformOutputShape) fields = op.transformOutputShape(step, fields);
  }
  return fields ? Array.from(fields).sort() : null;
}

/**
 * Compiles one node's TransformConfig against a source dialect. `dialect`
 * is null when the upstream source is unresolved or its manifest isn't one
 * of the 3 shipped connectors — everything is residual in that case (no
 * dialect to target).
 */
export function compilePushdown(dialect: SourceDialect | null, config: TransformConfig): PushdownPlan {
  if (!dialect || config.steps.length === 0) {
    return { dialectQuery: null, residualTransforms: config.steps, pushedDownCount: 0, residualCount: config.steps.length };
  }
  const { pushed, residual } = splitPushable(config.steps, dialect);
  if (pushed.length === 0) {
    return { dialectQuery: null, residualTransforms: residual, pushedDownCount: 0, residualCount: residual.length };
  }
  const dialectQuery = dialect === "mongo" ? compileMongo(pushed) : compileSql(pushed, dialect);
  return { dialectQuery, residualTransforms: residual, pushedDownCount: pushed.length, residualCount: residual.length };
}

// Re-exported for callers that want direct adapter access (queryBuilder.ts,
// writeGrantStatement.ts) without reaching into ops/dialects/* themselves.
export { mysqlAdapter, postgresAdapter, mongoAdapter };
export type { SqlDialectAdapter, MongoDialectAdapter };
