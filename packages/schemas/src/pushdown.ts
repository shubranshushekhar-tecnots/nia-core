import type { Expr } from "./expression.js";
import type { AggregateStep, AggregationSpec, FilterCondition, TransformConfig, TransformStep } from "./nodeConfig.js";

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
 */

export type SqlDialect = "mysql" | "postgres";
export type SourceDialect = SqlDialect | "mongo";

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

function isPushable(step: TransformStep, dialect: SourceDialect): boolean {
  switch (step.kind) {
    case "filter":
      return true;
    case "computed_field":
      return true;
    case "drop_fields":
      // Native field-exclusion projection ($project: {f: 0}) only exists in
      // Mongo's aggregation framework. Plain SQL has no "SELECT * EXCEPT
      // (col)" — expressing this would require enumerating every *kept*
      // column, which needs the full schema (out of scope this session, no
      // entity/column selection on source nodes yet). Real, disclosed
      // asymmetry, not an oversight.
      return dialect === "mongo";
    case "aggregate":
      // GROUP BY / $group exist in all 3 dialects — always structurally
      // pushable. splitPushable below still constrains WHERE an aggregate
      // step may land in the pushed list (only preceded by filters, and at
      // most one per node) for reasons that have nothing to do with dialect
      // support.
      return true;
  }
}

/**
 * Splits steps into a pushed-down prefix and a residual suffix, in original
 * order (order-stopping semantics — see this file's header comment).
 *
 * An `aggregate` step gets two EXTRA constraints beyond plain `isPushable`,
 * both v1 scope cuts (not dialect limitations):
 *  - it may only be preceded, within the pushed prefix, by `filter` steps —
 *    a pushed `computed_field`/`drop_fields` ahead of it would require the
 *    compiled statement to reference a computed/projected column inside its
 *    own GROUP BY/SELECT, i.e. a subquery or CTE layer; v1 only ever emits a
 *    single flat statement, so a non-filter step ahead of an aggregate
 *    blocks the aggregate (and everything after it) into residual instead;
 *  - at most ONE aggregate step is ever pushed per node — GROUP BY collapses
 *    row identity, so a second aggregate step immediately following a pushed
 *    one would have to aggregate an aggregate's *output* rows, which this
 *    compiler cannot express as one more clause on the same flat statement.
 *    That case (chained/multi-grain aggregation, e.g. the %-of-total-style
 *    composition in pushdown.test.ts) is real and supported — just executed
 *    residually (applyResidualTransforms operating on the pushed-down
 *    query's already-grouped output rows), not pushed twice.
 */
function splitPushable(steps: TransformStep[], dialect: SourceDialect): { pushed: TransformStep[]; residual: TransformStep[] } {
  const pushed: TransformStep[] = [];
  const residual: TransformStep[] = [];
  let blocked = false;
  let sawAggregate = false;
  let sawNonFilterBeforeAggregate = false;
  for (const step of steps) {
    if (blocked) {
      residual.push(step);
      continue;
    }
    if (sawAggregate) {
      // Nothing pushes past a pushed aggregate — see doc comment above.
      blocked = true;
      residual.push(step);
      continue;
    }
    if (step.kind === "aggregate") {
      if (sawNonFilterBeforeAggregate || !isPushable(step, dialect)) {
        blocked = true;
        residual.push(step);
        continue;
      }
      sawAggregate = true;
      pushed.push(step);
      continue;
    }
    if (!isPushable(step, dialect)) {
      blocked = true;
      residual.push(step);
      continue;
    }
    if (step.kind !== "filter") sawNonFilterBeforeAggregate = true;
    pushed.push(step);
  }
  return { pushed, residual };
}

// ---- SQL compilation -------------------------------------------------

function quoteIdent(name: string, dialect: SqlDialect): string {
  if (dialect === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

function placeholder(dialect: SqlDialect, index: number): string {
  return dialect === "mysql" ? "?" : `$${index}`;
}

/** Applies a FilterCondition's operator against an already-resolved SQL column/expression string — factored out of conditionToSql so havingClauseToSql (below) can reuse the exact same operator logic against a bare aggregate expression instead of a plain quoted column. */
function conditionToSqlColumn(colSql: string, cond: FilterCondition, dialect: SqlDialect, params: unknown[]): string {
  if (cond.operator === "is_null") return `${colSql} IS NULL`;
  if (cond.operator === "is_not_null") return `${colSql} IS NOT NULL`;
  if (cond.operator === "contains") {
    params.push(`%${cond.value}%`);
    return `${colSql} LIKE ${placeholder(dialect, params.length)}`;
  }
  const opSql: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
  params.push(cond.value);
  return `${colSql} ${opSql[cond.operator]} ${placeholder(dialect, params.length)}`;
}

function conditionToSql(cond: FilterCondition, dialect: SqlDialect, params: unknown[]): string {
  return conditionToSqlColumn(quoteIdent(cond.field, dialect), cond, dialect, params);
}

/** Bare (alias-less) SQL aggregate expression for one AggregationSpec — used both in the SELECT list (with `AS alias` appended there) and re-embedded verbatim inside HAVING, since SQL doesn't let HAVING reference a SELECT alias portably across mysql/postgres. */
function aggExprBare(agg: AggregationSpec, dialect: SqlDialect): string {
  if (agg.fn === "count") return "COUNT(*)";
  // field is non-null for every fn besides "count" — checkConfig (checks.ts) enforces this at check-time; schema-time parse stays permissive per this file's header convention, so field could in principle be null here for a not-yet-checked config. Fall back to COUNT(*) rather than emitting invalid SQL referencing a null column name.
  const col = agg.field ? quoteIdent(agg.field, dialect) : "*";
  switch (agg.fn) {
    case "count_field":
      return `COUNT(${col})`;
    case "count_distinct":
      return `COUNT(DISTINCT ${col})`;
    case "sum":
      return `SUM(${col})`;
    case "avg":
      return `AVG(${col})`;
    case "min":
      return `MIN(${col})`;
    case "max":
      return `MAX(${col})`;
    default:
      return "COUNT(*)";
  }
}

/**
 * Compiles an AggregateStep's `having` (ruling 2, docs/decisions.md): each
 * condition's `field` must resolve to either a sibling aggregation's alias
 * (re-embeds that aggregation's bare expression) or a groupBy field name
 * (a plain quoted column) — never a raw pre-aggregate column. checkConfig
 * (checks.ts) is the enforcement point for that restriction; this compiler
 * assumes it already passed and simply resolves whichever matches.
 */
function havingClauseToSql(having: FilterCondition[], step: AggregateStep, dialect: SqlDialect, params: unknown[]): string | null {
  if (having.length === 0) return null;
  const parts = having.map((cond) => {
    const agg = step.aggregations.find((a) => a.alias === cond.field);
    const colSql = agg ? aggExprBare(agg, dialect) : quoteIdent(cond.field, dialect);
    return `(${conditionToSqlColumn(colSql, cond, dialect, params)})`;
  });
  return parts.join(" AND ");
}

function exprToSql(expr: Expr, dialect: SqlDialect, params: unknown[]): string {
  switch (expr.kind) {
    case "field":
      return quoteIdent(expr.name, dialect);
    case "literal":
      params.push(expr.value);
      return placeholder(dialect, params.length);
    case "binary":
      return `(${exprToSql(expr.left, dialect, params)} ${expr.op} ${exprToSql(expr.right, dialect, params)})`;
    case "call": {
      const args = expr.args.map((a) => exprToSql(a, dialect, params));
      return expr.fn === "concat" ? `CONCAT(${args.join(", ")})` : `COALESCE(${args.join(", ")})`;
    }
  }
}

function compileSql(steps: TransformStep[], dialect: SqlDialect): SqlDialectQuery {
  const params: unknown[] = [];
  const whereParts: string[] = [];
  const selectParts: string[] = [];
  // splitPushable guarantees at most one aggregate, and only after any filters — see its doc comment.
  const aggregateStep = steps.find((s): s is AggregateStep => s.kind === "aggregate");
  for (const step of steps) {
    if (step.kind === "filter") {
      for (const cond of step.conditions) whereParts.push(conditionToSql(cond, dialect, params));
    } else if (step.kind === "computed_field") {
      selectParts.push(`${exprToSql(step.expression, dialect, params)} AS ${quoteIdent(step.name, dialect)}`);
    }
    // drop_fields never appears here — never pushable for SQL, see isPushable.
    // aggregate is handled separately below (it replaces, not adds to, the select list).
  }
  const whereSql = whereParts.length ? whereParts.map((p) => `(${p})`).join(" AND ") : null;

  if (!aggregateStep) {
    return { dialect, whereSql, selectSql: selectParts.length ? selectParts.join(", ") : null, params, isAggregate: false, groupBySql: null, havingSql: null };
  }

  const groupByCols = aggregateStep.groupBy.map((f) => quoteIdent(f, dialect));
  const aggCols = aggregateStep.aggregations.map((a) => `${aggExprBare(a, dialect)} AS ${quoteIdent(a.alias, dialect)}`);
  const fullSelect = [...groupByCols, ...aggCols];
  const havingSql = aggregateStep.having ? havingClauseToSql(aggregateStep.having, aggregateStep, dialect, params) : null;
  return {
    dialect,
    whereSql,
    selectSql: fullSelect.length ? fullSelect.join(", ") : null,
    params,
    isAggregate: true,
    groupBySql: groupByCols.length ? groupByCols.join(", ") : null,
    havingSql,
  };
}

// ---- Mongo compilation -------------------------------------------------

/** Escapes regex metacharacters so "contains" means literal substring search, never an attacker/user-controlled regex. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function conditionToMongo(cond: FilterCondition): Record<string, unknown> {
  switch (cond.operator) {
    case "eq":
      return { [cond.field]: { $eq: cond.value } };
    case "neq":
      return { [cond.field]: { $ne: cond.value } };
    case "gt":
      return { [cond.field]: { $gt: cond.value } };
    case "gte":
      return { [cond.field]: { $gte: cond.value } };
    case "lt":
      return { [cond.field]: { $lt: cond.value } };
    case "lte":
      return { [cond.field]: { $lte: cond.value } };
    case "contains":
      return { [cond.field]: { $regex: escapeRegExp(String(cond.value ?? "")), $options: "i" } };
    case "is_null":
      return { [cond.field]: { $eq: null } };
    case "is_not_null":
      return { [cond.field]: { $ne: null } };
  }
}

function exprToMongo(expr: Expr): unknown {
  switch (expr.kind) {
    case "field":
      return `$${expr.name}`;
    case "literal":
      return expr.value;
    case "binary": {
      const opMap = { "+": "$add", "-": "$subtract", "*": "$multiply", "/": "$divide" } as const;
      return { [opMap[expr.op]]: [exprToMongo(expr.left), exprToMongo(expr.right)] };
    }
    case "call":
      return expr.fn === "concat"
        ? { $concat: expr.args.map(exprToMongo) }
        : { $ifNull: expr.args.map(exprToMongo) };
  }
}

/** Bare $group accumulator expression for one AggregationSpec. count_distinct is handled by the caller (compileMongoAggregate) — it needs a $addToSet + $size two-stage sequence, not a single accumulator. */
function aggExprToMongo(agg: AggregationSpec): unknown {
  const fieldRef = agg.field ? `$${agg.field}` : null;
  switch (agg.fn) {
    case "count":
      return { $sum: 1 };
    case "count_field":
      // Mongo's $ne/$eq treat a missing field and an explicit null equivalently, so this counts only documents where the field is present and non-null — matching SQL's COUNT(col) semantics.
      return { $sum: { $cond: [{ $ne: [fieldRef, null] }, 1, 0] } };
    case "sum":
      return { $sum: fieldRef };
    case "avg":
      return { $avg: fieldRef };
    case "min":
      return { $min: fieldRef };
    case "max":
      return { $max: fieldRef };
    case "count_distinct":
      // Never reached directly — compileMongoAggregate special-cases count_distinct before calling this.
      return { $sum: 0 };
  }
}

/**
 * Compiles one AggregateStep into a $group + $addFields + $project sequence
 * (+ an optional trailing $match for `having`).
 *
 * - $group: `_id: null` for a whole-table aggregate (empty groupBy), else
 *   `_id: {<field>: "$<field>", ...}` for each groupBy field — Mongo's
 *   $group always needs a single `_id` expression, so multi-field grouping
 *   nests under it rather than using top-level keys.
 * - count_distinct has no single $group accumulator in Mongo's aggregation
 *   framework, so it's compiled as `$addToSet` into a temp field during
 *   $group, then `$size` of that temp field during $addFields (a documented,
 *   standard two-stage pattern) — the temp field is then dropped by $project.
 * - $addFields promotes each groupBy field back out of `_id.<field>` to a
 *   top-level `<field>` name (matching what the SQL side calls it, and what
 *   `having`/downstream steps reference), and resolves the count_distinct
 *   temp fields via $size.
 * - $project drops `_id` and any count_distinct temp fields, leaving only
 *   groupBy fields + aggregation aliases — mirrors the SQL side's replacement
 *   (not additive) select list.
 * - `having` (ruling 2) becomes a trailing $match, safe to reference plain
 *   top-level alias/groupBy field names at this point since $project has
 *   already flattened them.
 */
function compileMongoAggregate(step: AggregateStep): Record<string, unknown>[] {
  const groupId: Record<string, unknown> = {};
  for (const field of step.groupBy) groupId[field] = `$${field}`;

  const groupStage: Record<string, unknown> = { _id: step.groupBy.length ? groupId : null };
  const addFields: Record<string, unknown> = {};
  const projectDrop: Record<string, unknown> = { _id: 0 };

  for (const field of step.groupBy) addFields[field] = `$_id.${field}`;

  for (const agg of step.aggregations) {
    if (agg.fn === "count_distinct") {
      const tempField = `__distinct_${agg.alias}`;
      groupStage[tempField] = { $addToSet: agg.field ? `$${agg.field}` : null };
      addFields[agg.alias] = { $size: `$${tempField}` };
      projectDrop[tempField] = 0;
    } else {
      groupStage[agg.alias] = aggExprToMongo(agg);
    }
  }

  const pipeline: Record<string, unknown>[] = [{ $group: groupStage }, { $addFields: addFields }, { $project: projectDrop }];

  if (step.having && step.having.length > 0) {
    const clauses = step.having.map(conditionToMongo);
    pipeline.push({ $match: clauses.length === 1 ? clauses[0] : { $and: clauses } });
  }

  return pipeline;
}

function compileMongo(steps: TransformStep[]): MongoDialectQuery {
  const pipeline: Record<string, unknown>[] = [];
  let isAggregate = false;
  for (const step of steps) {
    if (step.kind === "filter") {
      if (step.conditions.length === 0) continue;
      const clauses = step.conditions.map(conditionToMongo);
      pipeline.push({ $match: clauses.length === 1 ? clauses[0] : { $and: clauses } });
    } else if (step.kind === "computed_field") {
      pipeline.push({ $addFields: { [step.name]: exprToMongo(step.expression) } });
    } else if (step.kind === "drop_fields") {
      if (step.fields.length === 0) continue;
      pipeline.push({ $project: Object.fromEntries(step.fields.map((f) => [f, 0])) });
    } else if (step.kind === "aggregate") {
      // splitPushable guarantees this is the last step and only preceded by filters.
      pipeline.push(...compileMongoAggregate(step));
      isAggregate = true;
    }
  }
  return { dialect: "mongo", pipeline, isAggregate };
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
