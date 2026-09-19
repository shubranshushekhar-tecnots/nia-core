import type { Expr } from "../../expression.js";
import type { AggregationSpec, FilterCondition } from "../../nodeConfig.js";
import type { MongoDialectAdapter } from "../types.js";

/** Escapes regex metacharacters so "contains" means literal substring search, never an attacker/user-controlled regex. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileCondition(cond: FilterCondition): Record<string, unknown> {
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

function compileExpr(expr: Expr): unknown {
  switch (expr.kind) {
    case "field":
      return `$${expr.name}`;
    case "literal":
      return expr.value;
    case "binary": {
      const opMap = { "+": "$add", "-": "$subtract", "*": "$multiply", "/": "$divide" } as const;
      return { [opMap[expr.op]]: [compileExpr(expr.left), compileExpr(expr.right)] };
    }
    case "call": {
      if (expr.fn === "concat") return { $concat: expr.args.map(compileExpr) };
      if (expr.fn === "coalesce") return { $ifNull: expr.args.map(compileExpr) };
      if (expr.fn === "contains") {
        const valueArg = expr.args[1]!;
        const pattern = valueArg.kind === "literal" ? escapeRegExp(String(valueArg.value)) : compileExpr(valueArg);
        return { $regexMatch: { input: compileExpr(expr.args[0]!), regex: pattern, options: "i" } };
      }
      if (expr.fn === "is_null") return { $eq: [compileExpr(expr.args[0]!), null] };
      if (expr.fn === "is_not_null") return { $ne: [compileExpr(expr.args[0]!), null] };
      if (expr.fn === "is_number") return { $isNumber: compileExpr(expr.args[0]!) };
      // is_text
      return { $eq: [{ $type: compileExpr(expr.args[0]!) }, "string"] };
    }
    case "comparison": {
      const opMap = { eq: "$eq", neq: "$ne", gt: "$gt", gte: "$gte", lt: "$lt", lte: "$lte" } as const;
      return { [opMap[expr.op]]: [compileExpr(expr.left), compileExpr(expr.right)] };
    }
    case "logical": {
      if (expr.op === "not") return { $not: [compileExpr(expr.args[0]!)] };
      const opMap = { and: "$and", or: "$or" } as const;
      return { [opMap[expr.op]]: expr.args.map(compileExpr) };
    }
    case "conditional": {
      return {
        $switch: {
          branches: expr.branches.map((b) => ({ case: compileExpr(b.when), then: compileExpr(b.then) })),
          default: compileExpr(expr.else),
        },
      };
    }
  }
}

/** Bare $group accumulator expression for one AggregationSpec. count_distinct is handled by the aggregate op itself — it needs a $addToSet + $size two-stage sequence, not a single accumulator. */
function compileAggAccumulator(agg: AggregationSpec): unknown {
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
      // Never reached directly — the aggregate op special-cases count_distinct before calling this.
      return { $sum: 0 };
  }
}

function combineAnd(clauses: Record<string, unknown>[]): Record<string, unknown> | null {
  if (clauses.length === 0) return null;
  if (clauses.length === 1) return clauses[0]!;
  return { $and: clauses };
}

export const mongoAdapter: MongoDialectAdapter = {
  dialect: "mongo",
  compileExpr,
  compileCondition,
  compileAggAccumulator,
  combineAnd,
};
