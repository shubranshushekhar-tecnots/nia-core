import type { Expr } from "../../expression.js";
import type { AggregationSpec, FilterCondition } from "../../nodeConfig.js";
import type { SqlDialect, SqlDialectAdapter } from "../types.js";

/**
 * The 5 dialect-family-generic SQL primitive bodies, written once and
 * shared by both `mysql` and `postgres` — those two dialects differ only
 * in identifier quoting and placeholder syntax, which is exactly what the
 * two injected functions supply. See ops/types.ts's SqlDialectAdapter doc
 * comments for what each primitive means; bodies here are ported verbatim
 * from the pre-refactor pushdown.ts (conditionToSqlColumn/conditionToSql,
 * aggExprBare, exprToSql, and the whereParts wrapping logic in compileSql/
 * havingClauseToSql), not reimplemented.
 */
export function makeSqlDialectAdapter(
  dialect: SqlDialect,
  quoteIdent: (name: string) => string,
  placeholder: (index: number) => string,
): SqlDialectAdapter {
  function compileConditionAgainstTarget(target: string, cond: FilterCondition, params: unknown[]): string {
    if (cond.operator === "is_null") return `${target} IS NULL`;
    if (cond.operator === "is_not_null") return `${target} IS NOT NULL`;
    if (cond.operator === "contains") {
      params.push(`%${cond.value}%`);
      return `${target} LIKE ${placeholder(params.length)}`;
    }
    const opSql: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
    params.push(cond.value);
    return `${target} ${opSql[cond.operator]} ${placeholder(params.length)}`;
  }

  function compileCondition(cond: FilterCondition, params: unknown[]): string {
    return compileConditionAgainstTarget(quoteIdent(cond.field), cond, params);
  }

  function compileAggAccumulator(agg: AggregationSpec): string {
    if (agg.fn === "count") return "COUNT(*)";
    // field is non-null for every fn besides "count" — checkConfig (checks.ts) enforces this at check-time; schema-time parse stays permissive per this repo's convention, so field could in principle be null here for a not-yet-checked config. Fall back to COUNT(*) rather than emitting invalid SQL referencing a null column name.
    const col = agg.field ? quoteIdent(agg.field) : "*";
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
   * Backs the "is_number" call-fn (and "is_text"'s negation of it) — the
   * one place mysql/postgres bodies actually diverge in this otherwise
   * dialect-generic factory, since MySQL's `REGEXP` and Postgres's `~`
   * take the same POSIX-ish pattern but differ in string-literal
   * backslash-escaping: MySQL string literals themselves interpret `\\`,
   * so a literal single backslash for the regex engine needs `\\\\` in
   * the emitted SQL text; Postgres (standard_conforming_strings=on,
   * default since 9.1) treats string literals literally, so one
   * backslash (`\\` in this JS source) suffices.
   */
  function compileIsNumberSql(target: string): string {
    return dialect === "mysql" ? `(${target} REGEXP '^-?[0-9]+(\\\\.[0-9]+)?$')` : `(${target} ~ '^-?[0-9]+(\\.[0-9]+)?$')`;
  }

  function compileExpr(expr: Expr, params: unknown[]): string {
    switch (expr.kind) {
      case "field":
        return quoteIdent(expr.name);
      case "literal":
        params.push(expr.value);
        return placeholder(params.length);
      case "binary":
        return `(${compileExpr(expr.left, params)} ${expr.op} ${compileExpr(expr.right, params)})`;
      case "call": {
        if (expr.fn === "concat") return `CONCAT(${expr.args.map((a) => compileExpr(a, params)).join(", ")})`;
        if (expr.fn === "coalesce") return `COALESCE(${expr.args.map((a) => compileExpr(a, params)).join(", ")})`;
        if (expr.fn === "contains") {
          const target = compileExpr(expr.args[0]!, params);
          const valueArg = expr.args[1]!;
          if (valueArg.kind === "literal") {
            params.push(`%${String(valueArg.value)}%`);
            return `${target} LIKE ${placeholder(params.length)}`;
          }
          return `${target} LIKE CONCAT('%', ${compileExpr(valueArg, params)}, '%')`;
        }
        if (expr.fn === "is_null") return `${compileExpr(expr.args[0]!, params)} IS NULL`;
        if (expr.fn === "is_not_null") return `${compileExpr(expr.args[0]!, params)} IS NOT NULL`;
        const target = compileExpr(expr.args[0]!, params);
        const isNumberSql = compileIsNumberSql(target);
        return expr.fn === "is_number" ? isNumberSql : `(${target} IS NOT NULL AND NOT ${isNumberSql})`;
      }
      case "comparison": {
        const opSql: Record<typeof expr.op, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
        return `(${compileExpr(expr.left, params)} ${opSql[expr.op]} ${compileExpr(expr.right, params)})`;
      }
      case "logical": {
        if (expr.op === "not") return `(NOT ${compileExpr(expr.args[0]!, params)})`;
        const joiner = expr.op === "and" ? " AND " : " OR ";
        return `(${expr.args.map((a) => compileExpr(a, params)).join(joiner)})`;
      }
      case "conditional": {
        const whens = expr.branches.map((b) => `WHEN ${compileExpr(b.when, params)} THEN ${compileExpr(b.then, params)}`).join(" ");
        return `(CASE ${whens} ELSE ${compileExpr(expr.else, params)} END)`;
      }
    }
  }

  function combineAnd(fragments: string[]): string | null {
    return fragments.length ? fragments.map((p) => `(${p})`).join(" AND ") : null;
  }

  return {
    dialect,
    quoteIdent,
    placeholder,
    compileExpr,
    compileCondition,
    compileConditionAgainstTarget,
    compileAggAccumulator,
    combineAnd,
  };
}
