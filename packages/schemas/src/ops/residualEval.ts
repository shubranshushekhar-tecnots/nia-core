import type { Expr } from "../expression.js";

/**
 * Generic per-row evaluation helper shared by multiple ops' `applyResidual`
 * (filter's `expr`, computed_field's `expression`, aggregate's `having`) —
 * not dialect-specific, so this lives here rather than on any
 * DialectAdapter. The field/literal/binary/call cases are ported verbatim
 * from the pre-refactor residualTransform.ts; the comparison/logical/
 * conditional cases (Phase 8b-1) fold in what used to be the standalone
 * `matchesCondition` (deleted — its per-operator logic is reproduced here
 * exactly, now reachable through any position in an Expr tree instead of
 * only a flat FilterCondition).
 *
 * Two-valued, JS-native coercion throughout (e.g. `Number(null) === 0`, so
 * `null > -1` is `true` here) — a real, disclosed divergence from SQL's
 * three-valued NULL logic and Mongo's BSON-comparison semantics. Not
 * homogenized: this is the residual (in-process) fallback path only, and
 * this divergence already existed pre-8b-1 for matchesCondition's
 * operators; the new comparison/logical/conditional cases just extend the
 * same semantics to a real expression tree instead of a flat condition list.
 */
const NUMBER_PATTERN = /^-?[0-9]+(\.[0-9]+)?$/;
function isNumericValue(v: unknown): boolean {
  return typeof v === "number" || (typeof v === "string" && NUMBER_PATTERN.test(v));
}

export function evalExpr(expr: Expr, row: Record<string, unknown>): unknown {
  switch (expr.kind) {
    case "field":
      return row[expr.name] ?? null;
    case "literal":
      return expr.value;
    case "binary": {
      const left = Number(evalExpr(expr.left, row));
      const right = Number(evalExpr(expr.right, row));
      switch (expr.op) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          return left / right;
      }
    }
    case "call": {
      if (expr.fn === "concat") return expr.args.map((a) => evalExpr(a, row)).map((v) => v ?? "").join("");
      if (expr.fn === "coalesce") {
        for (const a of expr.args) {
          const v = evalExpr(a, row);
          if (v !== null && v !== undefined) return v;
        }
        return null;
      }
      if (expr.fn === "is_null") {
        const v = evalExpr(expr.args[0]!, row);
        return v === null || v === undefined;
      }
      if (expr.fn === "is_not_null") {
        const v = evalExpr(expr.args[0]!, row);
        return v !== null && v !== undefined;
      }
      if (expr.fn === "contains") {
        const actual = evalExpr(expr.args[0]!, row);
        const needle = evalExpr(expr.args[1]!, row);
        return typeof actual === "string" && typeof needle === "string" && actual.includes(needle);
      }
      if (expr.fn === "is_number") return isNumericValue(evalExpr(expr.args[0]!, row));
      // is_text
      const v = evalExpr(expr.args[0]!, row);
      return v !== null && v !== undefined && !isNumericValue(v);
    }
    case "comparison": {
      const left = evalExpr(expr.left, row);
      const right = evalExpr(expr.right, row);
      switch (expr.op) {
        case "eq":
          return left === right;
        case "neq":
          return left !== right;
        case "gt":
          return Number(left) > Number(right);
        case "gte":
          return Number(left) >= Number(right);
        case "lt":
          return Number(left) < Number(right);
        case "lte":
          return Number(left) <= Number(right);
      }
    }
    case "logical": {
      if (expr.op === "not") return !evalExpr(expr.args[0]!, row);
      if (expr.op === "and") return expr.args.every((a) => Boolean(evalExpr(a, row)));
      return expr.args.some((a) => Boolean(evalExpr(a, row)));
    }
    case "conditional": {
      for (const b of expr.branches) {
        if (Boolean(evalExpr(b.when, row))) return evalExpr(b.then, row);
      }
      return evalExpr(expr.else, row);
    }
  }
}
