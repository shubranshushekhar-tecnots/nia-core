import type { Expr } from "./expression.js";
import type { FilterCondition, TransformConfig, TransformStep } from "./nodeConfig.js";

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
  /** Comma-joined `expr AS "alias"` fragments for pushed computed fields. Null when none. */
  selectSql: string | null;
  /** Positional params in emission order — mysql binds by `?`, postgres by `$n`; both are represented as a plain ordered array here, the executor binds per its own driver. */
  params: unknown[];
};

export type MongoDialectQuery = {
  dialect: "mongo";
  pipeline: Record<string, unknown>[];
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
  }
}

function splitPushable(steps: TransformStep[], dialect: SourceDialect): { pushed: TransformStep[]; residual: TransformStep[] } {
  const pushed: TransformStep[] = [];
  const residual: TransformStep[] = [];
  let blocked = false;
  for (const step of steps) {
    if (!blocked && isPushable(step, dialect)) {
      pushed.push(step);
    } else {
      blocked = true;
      residual.push(step);
    }
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

function conditionToSql(cond: FilterCondition, dialect: SqlDialect, params: unknown[]): string {
  const col = quoteIdent(cond.field, dialect);
  if (cond.operator === "is_null") return `${col} IS NULL`;
  if (cond.operator === "is_not_null") return `${col} IS NOT NULL`;
  if (cond.operator === "contains") {
    params.push(`%${cond.value}%`);
    return `${col} LIKE ${placeholder(dialect, params.length)}`;
  }
  const opSql: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
  params.push(cond.value);
  return `${col} ${opSql[cond.operator]} ${placeholder(dialect, params.length)}`;
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
  for (const step of steps) {
    if (step.kind === "filter") {
      for (const cond of step.conditions) whereParts.push(conditionToSql(cond, dialect, params));
    } else if (step.kind === "computed_field") {
      selectParts.push(`${exprToSql(step.expression, dialect, params)} AS ${quoteIdent(step.name, dialect)}`);
    }
    // drop_fields never appears here — never pushable for SQL, see isPushable.
  }
  return {
    dialect,
    whereSql: whereParts.length ? whereParts.map((p) => `(${p})`).join(" AND ") : null,
    selectSql: selectParts.length ? selectParts.join(", ") : null,
    params,
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

function compileMongo(steps: TransformStep[]): MongoDialectQuery {
  const pipeline: Record<string, unknown>[] = [];
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
    }
  }
  return { dialect: "mongo", pipeline };
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
