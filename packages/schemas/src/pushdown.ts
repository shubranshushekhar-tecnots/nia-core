import type { FilterCondition, OnFailurePolicy, TransformConfig, TransformStep } from "./nodeConfig.js";
import type { CallFn, Expr } from "./expression.js";
import type {
  MongoDialectAdapter,
  OpKind,
  SqlDialectAdapter,
  SqlEmitContext,
  MongoEmitContext,
} from "./ops/types.js";
import { opForStep } from "./ops/registry.js";
import { mysqlAdapter } from "./ops/dialects/mysql.js";
import { postgresAdapter } from "./ops/dialects/postgres.js";
import { mongoAdapter } from "./ops/dialects/mongo.js";
import { createParamSink, resolveParamSink, type ParamSink } from "./ops/paramSink.js";
import { buildFailureExpr, fallibleFnsIn, resolveOnFailure } from "./ops/onFailure.js";

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
  /**
   * Phase 9 Part 3: comma-joined ORDER BY column list for paginating a
   * pushed aggregate's output, exactly matching groupBySql's columns and
   * their order (standing rule 2 — ORDER BY, GROUP BY, and the keyset
   * comparison must agree). Each column is suffixed with `NULLS FIRST` on
   * postgres (its ASC default is NULLS LAST); mysql already sorts NULL
   * first for ASC with no forcing needed. Null when isAggregate is false,
   * or the aggregate has no groupBy columns (a whole-table aggregate
   * always produces exactly one row — nothing to page or order).
   */
  orderBySql: string | null;
  /**
   * Fix (numeric group keys under MySQL pagination): mysql-only list of
   * hidden SELECT alias names, one per groupBy column in the same order as
   * groupBySql/orderBySql, carrying that column's byte-order-encoded value
   * (see aggregate.ts's emitSql). The group-key keyset cursor (runEtl.ts)
   * must be read from these columns instead of the plain groupBy column —
   * ORDER BY sorts every mysql groupBy column byte-wise regardless of type
   * (see aggregate.ts), so the WHERE-side keyset comparison must compare
   * using that exact same byte order or a numeric column can skip/duplicate
   * groups across pages ("10" sorting before "9"). These columns are never
   * real output — callers must strip them before residual transforms/write.
   * Null for postgres (no collation mismatch there) and for a whole-table
   * aggregate (empty groupBy) or when isAggregate is false.
   */
  groupCursorColumns: string[] | null;
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

/**
 * Phase 9 Part 2 — a SQL keyset-pagination cursor condition, threaded into
 * `compileSql`/`compilePushdown` so it resolves through the SAME ParamSink
 * pass as every other literal (see ops/paramSink.ts's doc comment for the
 * arg(n)/params-array desync story this closes). Previously, callers
 * (apps/worker's queryBuilder.ts) hand-appended `key > ?` AFTER
 * `compileSql` had already resolved every other param, choosing the
 * cursor's placeholder from `params.length` — safe only by the accident
 * that the non-aggregate path never also has a HAVING clause. Passing the
 * cursor in here instead means its token is just one more fragment
 * `resolveParamSink` resolves in real physical text order, with zero
 * special-casing. Mongo has no equivalent (see paramSink.ts's doc comment
 * — no ParamSink concept there at all), so this only ever reaches
 * `compileSql`, never `compileMongo`.
 */
export type SqlKeysetCursor = { column: string; value: string | number };

/**
 * Phase 9 Part 3 — the cursor for paginating a pushed aggregate's GROUP BY
 * output: the last page's final group-key tuple, one value per groupBy
 * column, in the same order as the aggregate step's own `groupBy` array
 * (which `orderBySql`/`groupBySql` also share — standing rule 2). `null` in
 * `values` means that column's group key was itself NULL (NULL sorts first
 * on every dialect here — see buildGroupKeysetWhereSql's doc comment).
 * Mutually exclusive with `SqlKeysetCursor`: a pushed aggregate is never
 * also keyset-paginated by a raw primary key (GROUP BY has already
 * collapsed row identity), and a non-aggregate query has no group key to
 * page by.
 */
export type SqlGroupKeyCursor = { columns: string[]; values: (string | number | null)[] };

function sqlAdapterFor(dialect: SqlDialect): SqlDialectAdapter {
  return dialect === "mysql" ? mysqlAdapter : postgresAdapter;
}

/**
 * One step of the group-key keyset predicate's lexicographic expansion
 * (see buildGroupKeysetWhereSql/buildGroupKeysetMatchMongo). Reuses the
 * ordinary FilterCondition shape so it compiles through the SAME
 * adapter.compileCondition every plain `filter` step already uses — this
 * is what makes the mysql BINARY-collation standing rule (Fix 1,
 * sqlShared.ts) apply here automatically, with zero new collation-specific
 * code: if a future fix changes how string equality/ordering compiles for
 * a filter condition, this predicate picks it up for free.
 *
 * `wantGreater: false` asks for "this column equals the cursor's value at
 * this position" (the lexicographic prefix-equality steps); `true` asks
 * for "this column sorts after the cursor's value" (the final, deciding
 * step of each OR-branch). NULL sorts first on every dialect here, so a
 * NULL cursor value can't use plain `=`/`>` (three-valued NULL logic makes
 * both always UNKNOWN) — a NULL "equals" step becomes `IS NULL`, and a
 * NULL "greater than" step becomes `IS NOT NULL` (since NULL already
 * sorted first, anything non-null sorts after it).
 */
function groupKeyStepCondition(field: string, value: string | number | null, wantGreater: boolean): FilterCondition {
  if (value === null) {
    return { field, operator: wantGreater ? "is_not_null" : "is_null" };
  }
  return { field, operator: wantGreater ? "gt" : "eq", value };
}

/**
 * Fix (numeric group keys under MySQL pagination): the WHERE-side target
 * expression for a group-key keyset comparison must match the exact
 * expression ORDER BY sorts by (aggregate.ts's `groupOrderCols`), not the
 * plain column — mysql forces byte-wise ordering there for EVERY groupBy
 * column regardless of type, encoded as `HEX(BINARY col)` for the cursor
 * (see aggregate.ts's emitSql doc comment for why HEX, not a bare BINARY
 * cast). Postgres has no such collation mismatch, so its target stays the
 * plain quoted column.
 */
function groupKeyTarget(adapter: SqlDialectAdapter, field: string): string {
  const quoted = adapter.quoteIdent(field);
  return adapter.dialect === "mysql" ? `HEX(BINARY ${quoted})` : quoted;
}

/**
 * Phase 9 Part 3 — lexicographic multi-column keyset predicate, expanded
 * manually (never a row-constructor comparison like `(c1,c2) > (v1,v2)`,
 * per the plan) as:
 *
 *   gt(c1,v1)
 *   OR (eq(c1,v1) AND gt(c2,v2))
 *   OR (eq(c1,v1) AND eq(c2,v2) AND gt(c3,v3))
 *   ...
 *
 * Applied as a plain WHERE fragment BEFORE grouping — valid because pushed
 * group-by columns are always raw, unmodified source columns (never
 * computed), so filtering the pre-group rows on those same columns
 * produces exactly the post-group rows whose group key sorts after the
 * cursor.
 *
 * Fix (numeric group keys under MySQL pagination): compiles each condition
 * against `groupKeyTarget(adapter, column)` (via compileConditionAgainstTarget)
 * instead of the plain column via compileCondition — the WHERE-side target
 * now matches ORDER BY's byte order exactly, and `values` are expected to
 * already be the corresponding cursor-column values (HEX(BINARY ...)
 * strings for mysql, plain values for postgres) — see
 * SqlGroupKeyCursor's doc comment.
 */
function buildGroupKeysetWhereSql(adapter: SqlDialectAdapter, sink: ParamSink, columns: string[], values: (string | number | null)[]): string {
  const orBranches: string[] = [];
  for (let i = 0; i < columns.length; i++) {
    const andParts: string[] = [];
    for (let j = 0; j < i; j++) {
      const target = groupKeyTarget(adapter, columns[j]!);
      andParts.push(adapter.compileConditionAgainstTarget(target, groupKeyStepCondition(columns[j]!, values[j]!, false), sink));
    }
    const target = groupKeyTarget(adapter, columns[i]!);
    andParts.push(adapter.compileConditionAgainstTarget(target, groupKeyStepCondition(columns[i]!, values[i]!, true), sink));
    orBranches.push(adapter.combineAnd(andParts)!);
  }
  return orBranches.length > 1 ? `(${orBranches.join(" OR ")})` : orBranches[0]!;
}

/** Same lexicographic expansion as buildGroupKeysetWhereSql, in Mongo query-object shape, reusing mongoAdapter's own compileCondition/combineAnd (same FilterCondition contract, no ParamSink — Mongo embeds literals directly). Applied as a `$match` stage before `$group`. */
function buildGroupKeysetMatchMongo(columns: string[], values: (string | number | null)[]): Record<string, unknown> {
  const orBranches: Record<string, unknown>[] = [];
  for (let i = 0; i < columns.length; i++) {
    const andParts: Record<string, unknown>[] = [];
    for (let j = 0; j < i; j++) {
      andParts.push(mongoAdapter.compileCondition(groupKeyStepCondition(columns[j]!, values[j]!, false)));
    }
    andParts.push(mongoAdapter.compileCondition(groupKeyStepCondition(columns[i]!, values[i]!, true)));
    orBranches.push(mongoAdapter.combineAnd(andParts)!);
  }
  return orBranches.length > 1 ? { $or: orBranches } : orBranches[0]!;
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

function compileSql(steps: TransformStep[], dialect: SqlDialect, cursor?: SqlKeysetCursor, groupKeyCursor?: SqlGroupKeyCursor): SqlDialectQuery {
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
  let aggregateResult: { select: string[]; groupBy: string[] | null; having: string | null; cursorColumns: string[] | null } | null = null;

  const ctx: SqlEmitContext = {
    adapter,
    params: sink,
    addWhere(fragment) {
      whereFragments.push(fragment);
    },
    addSelect(fragment) {
      selectFragments.push(fragment);
    },
    setAggregate(select, groupBy, having, cursorColumns) {
      aggregateResult = { select, groupBy, having, cursorColumns: cursorColumns ?? null };
    },
  };

  for (const step of steps) {
    opForStep(step).emitSql?.(step, ctx);
  }

  // Phase 9 Part 2: the keyset cursor is just one more AND'd fragment,
  // pushed onto the SAME sink as every other literal, BEFORE
  // resolveParamSink runs below — so its token resolves in real physical
  // text order along with everything else, never appended after the fact.
  // Never applies to an aggregate query (GROUP BY has already collapsed
  // the source primary key the cursor would page on — see
  // SqlDialectQuery.isAggregate's doc comment); silently ignored here
  // rather than the caller special-casing it, since callers may pass a
  // cursor unconditionally.
  if (cursor && !aggregateResult) {
    const token = sink.push(cursor.value);
    whereFragments.push(`${adapter.quoteIdent(cursor.column)} > ${token}`);
  }

  // Phase 9 Part 3: the group-key pagination predicate is applied as a
  // plain WHERE fragment too — BEFORE grouping (see
  // buildGroupKeysetWhereSql's doc comment for why that's valid). Never
  // combined with `cursor` above — mutually exclusive by construction
  // (callers only ever pass one or the other; see SqlGroupKeyCursor's doc
  // comment).
  if (groupKeyCursor && aggregateResult && groupKeyCursor.columns.length > 0) {
    whereFragments.push(buildGroupKeysetWhereSql(adapter, sink, groupKeyCursor.columns, groupKeyCursor.values));
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
    return { dialect, whereSql, selectSql, params, isAggregate: false, groupBySql: null, havingSql: null, orderBySql: null, groupCursorColumns: null };
  }

  const { select, groupBy, having, cursorColumns } = aggregateResult as {
    select: string[];
    groupBy: string[] | null;
    having: string | null;
    cursorColumns: string[] | null;
  };
  const selectJoined = select.length ? select.join(", ") : null;
  // Phase 9 adversarial-case follow-up: mysql's default column collation is
  // case-insensitive (confirmed live: `GROUP BY \`grp\`` alone silently
  // merges "a" and "A" into one group). Fixed at the source, in
  // aggregate.ts's emitSql: it already hands this function `groupBy`
  // entries pre-cast as `BINARY \`grp\`` for mysql (and its SELECT list
  // uses `ANY_VALUE(\`grp\`)` instead of the plain column, to satisfy
  // ONLY_FULL_GROUP_BY once GROUP BY no longer textually matches a plain
  // `SELECT \`grp\``) — see that file's comment for the full rationale.
  // This function just joins whatever column expressions it's given,
  // dialect-agnostic; no BINARY-specific logic belongs here.
  const groupByJoined = groupBy && groupBy.length ? groupBy.join(", ") : null;
  // Phase 9 Part 3: same columns/order as groupByJoined, each suffixed
  // with NULLS FIRST on postgres only (see SqlDialectQuery.orderBySql's
  // doc comment) — computed directly, not through ParamSink (no literal
  // values here, just quoted identifiers + a keyword).
  const orderByJoined = groupBy && groupBy.length ? groupBy.map((col) => (dialect === "postgres" ? `${col} NULLS FIRST` : col)).join(", ") : null;
  // Physical order matches queryBuilder.ts's real assembly: `SELECT <selectSql> FROM ... WHERE <whereSql> GROUP BY <groupBySql> HAVING <havingSql>`.
  const { resolved, params } = resolveParamSink(
    sink,
    [selectJoined, whereJoined, groupByJoined, having] as [string | null, string | null, string | null, string | null],
    adapter.placeholder,
  );
  const [selectSql, whereSql, groupBySql, havingSql] = resolved;
  return { dialect, whereSql, selectSql, params, isAggregate: true, groupBySql, havingSql, orderBySql: orderByJoined, groupCursorColumns: cursorColumns };
}

// ---- Mongo compilation -------------------------------------------------

function compileMongo(steps: TransformStep[], groupKeyCursor?: SqlGroupKeyCursor): MongoDialectQuery {
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
    // Phase 9 Part 3: special-cased on step.kind (same precedent as
    // compileSql's aggregateResult branch above — pushed aggregate is
    // already a first-class special case, not a generic op hook) so the
    // group-key `$match` lands immediately before `$group` (plan: "$match
    // before $group on mongo"), and the pagination `$sort` lands right
    // after aggregateOp.emitMongo's own $group/$addFields/$project/
    // $match(having) stages — sorting after a having-filter doesn't change
    // the relative order of surviving rows, so this is equivalent to
    // sorting before it, just reusing the same insertion point either way.
    if (step.kind === "aggregate") {
      if (groupKeyCursor && groupKeyCursor.columns.length > 0) {
        pipeline.push({ $match: buildGroupKeysetMatchMongo(groupKeyCursor.columns, groupKeyCursor.values) });
      }
      opForStep(step).emitMongo?.(step, ctx);
      if (step.groupBy.length > 0) {
        const sort: Record<string, 1> = {};
        for (const field of step.groupBy) sort[field] = 1;
        pipeline.push({ $sort: sort });
      }
      continue;
    }
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
export function compilePushdown(
  dialect: SourceDialect | null,
  config: TransformConfig,
  cursor?: SqlKeysetCursor,
  groupKeyCursor?: SqlGroupKeyCursor,
): PushdownPlan {
  if (!dialect) {
    return { dialectQuery: null, residualTransforms: config.steps, pushedDownCount: 0, residualCount: config.steps.length };
  }
  if (config.steps.length === 0) {
    // No transform steps to push, but a SQL keyset cursor still needs to
    // compile through the same ParamSink path (queryBuilder.ts's base
    // `SELECT * FROM entity WHERE key > cursor` read, with no transform
    // node involved at all). No aggregate is possible here, so
    // groupKeyCursor never applies.
    const dialectQuery = dialect !== "mongo" && cursor ? compileSql([], dialect, cursor) : null;
    return { dialectQuery, residualTransforms: config.steps, pushedDownCount: 0, residualCount: config.steps.length };
  }
  const { pushed, residual } = splitPushable(config.steps, dialect);
  if (pushed.length === 0) {
    const dialectQuery = dialect !== "mongo" && cursor ? compileSql([], dialect, cursor) : null;
    return { dialectQuery, residualTransforms: residual, pushedDownCount: 0, residualCount: residual.length };
  }
  const dialectQuery = dialect === "mongo" ? compileMongo(pushed, groupKeyCursor) : compileSql(pushed, dialect, cursor, groupKeyCursor);
  return { dialectQuery, residualTransforms: residual, pushedDownCount: pushed.length, residualCount: residual.length };
}

/** One pushed step's fallible expression + the label computeFailureReport would have used for it residually — the exact same label text, so a pre-check abort's message is indistinguishable from a residual abort's. Only filter/computed_field/aggregate ever carry a fallible expr (having, for aggregate); every other op kind returns null. */
function fallibleExprFor(step: TransformStep): { expr: Expr; policy: OnFailurePolicy | undefined; label: string } | null {
  if (step.kind === "filter") return { expr: step.expr, policy: step.onFailure, label: "filter" };
  if (step.kind === "computed_field") return { expr: step.expression, policy: step.onFailure, label: `computed_field "${step.name}"` };
  if (step.kind === "aggregate" && step.having) return { expr: step.having, policy: step.onFailure, label: "aggregate having" };
  return null;
}

/**
 * Phase 9 Part 4 — one pre-check per pushed step whose real expression
 * contains a fallible call, run by the caller (runEtl.ts) as a single
 * `COUNT(*)` query BEFORE extraction, against the exact same upstream
 * pushed prefix. Lets a pushed "fail" step keep its "abort before any
 * write, with an exact count" guarantee (previously only available by
 * forcing the whole step residual — see onFailure.ts's top doc comment)
 * and gives pushed "null"/"drop" steps a real failure count for the first
 * time (previously silent for a pushed step — see docs/decisions.md's
 * 8b-3 entry, resolved by this function).
 *
 * Implementation: reuses `compilePushdown`'s own private compileSql/
 * compileMongo on a SYNTHETIC steps array — the real pushed prefix before
 * this step, unchanged, followed by a stand-in step whose predicate is
 * `buildFailureExpr(realExpr)` instead of the real expression:
 *   - filter/computed_field: a plain `filter` step (WHERE/`$match` on the
 *     failure predicate — counts failing ROWS).
 *   - aggregate: the same aggregate step with `having` replaced by
 *     `buildFailureExpr(having)` (counts failing GROUPS, matching how the
 *     residual path's computeFailureReport already operates over
 *     post-aggregation rows).
 * No new SQL/Mongo generation code is needed for either shape:
 * `buildFailureExpr` only ever emits `is_null`/`is_not_null` wrapping the
 * original call/args (see expression.ts's doc comment on it), which is
 * unconditionally pushable on every dialect (ops/types.ts's
 * FN_PUSHABILITY) — so the synthetic step is always exactly as pushable as
 * the real step already was, with the SAME upstream prefix (including, for
 * aggregate, the alias-substitution `having` already goes through).
 *
 * Returns one entry per fallible pushed step, in step order (not
 * necessarily config.steps' full order — only pushed steps are checked;
 * residual steps already count their own failures via computeFailureReport
 * and don't need a pre-check). The caller turns each `dialectQuery`
 * fragment into a runnable `COUNT(*)`/`{$count}` statement (mirroring
 * queryBuilder.ts's buildEtlReadQuery pattern) and decides what to do with
 * the count based on `policy`.
 */
export type FailurePreCheck = {
  label: string;
  fns: CallFn[];
  policy: OnFailurePolicy;
  dialectQuery: DialectQuery;
};

export function compileFailurePreChecks(dialect: SourceDialect | null, config: TransformConfig): FailurePreCheck[] {
  if (!dialect) return [];
  const { pushed } = splitPushable(config.steps, dialect);
  const checks: FailurePreCheck[] = [];
  for (let i = 0; i < pushed.length; i++) {
    const step = pushed[i]!;
    const found = fallibleExprFor(step);
    if (!found) continue;
    const failureExpr = buildFailureExpr(found.expr);
    if (!failureExpr) continue;
    const prefix = pushed.slice(0, i);
    const syntheticStep: TransformStep =
      step.kind === "aggregate" ? { ...step, having: failureExpr } : { kind: "filter", expr: failureExpr };
    const syntheticSteps = [...prefix, syntheticStep];
    const dialectQuery = dialect === "mongo" ? compileMongo(syntheticSteps) : compileSql(syntheticSteps, dialect);
    checks.push({ label: found.label, fns: fallibleFnsIn(found.expr), policy: resolveOnFailure(found.policy), dialectQuery });
  }
  return checks;
}

// Re-exported for callers that want direct adapter access (queryBuilder.ts,
// writeGrantStatement.ts) without reaching into ops/dialects/* themselves.
export { mysqlAdapter, postgresAdapter, mongoAdapter };
export type { SqlDialectAdapter, MongoDialectAdapter };
