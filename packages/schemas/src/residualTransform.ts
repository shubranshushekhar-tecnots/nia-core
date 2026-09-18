import type { Expr } from "./expression.js";
import type { FilterCondition, TransformStep } from "./nodeConfig.js";

/**
 * In-process executor for the transform steps a pushdown compiler
 * (pushdown.ts) couldn't push into the source query — either because the
 * source has no compiler for its dialect, or (Phase 6 Block 3) because the
 * runner is deliberately skipping pushdown for a multi-transform-node chain
 * (see apps/worker/src/lib/etl/runEtl.ts). Unlike runPreview.ts's
 * buildPreviewQuery (which only ever *counts* residual steps for a >1-node
 * chain, never runs them), this module actually executes every step, in
 * order, against real fetched rows — the real ETL runner needs correct
 * output, not just a preview count.
 *
 * Steps run in array order, each seeing the previous step's output shape
 * (same contract TransformConfig.steps already documents for pushdown).
 */

function evalExpr(expr: Expr, row: Record<string, unknown>): unknown {
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
      const args = expr.args.map((a) => evalExpr(a, row));
      if (expr.fn === "concat") return args.map((v) => (v ?? "")).join("");
      // coalesce
      for (const v of args) {
        if (v !== null && v !== undefined) return v;
      }
      return null;
    }
  }
}

function matchesCondition(cond: FilterCondition, row: Record<string, unknown>): boolean {
  const actual = row[cond.field];
  switch (cond.operator) {
    case "is_null":
      return actual === null || actual === undefined;
    case "is_not_null":
      return actual !== null && actual !== undefined;
    case "eq":
      return actual === cond.value;
    case "neq":
      return actual !== cond.value;
    case "gt":
      return Number(actual) > Number(cond.value);
    case "gte":
      return Number(actual) >= Number(cond.value);
    case "lt":
      return Number(actual) < Number(cond.value);
    case "lte":
      return Number(actual) <= Number(cond.value);
    case "contains":
      return typeof actual === "string" && typeof cond.value === "string" && actual.includes(cond.value);
  }
}

export function applyResidualTransforms(
  columns: string[],
  rows: unknown[][],
  steps: TransformStep[],
): { columns: string[]; rows: unknown[][] } {
  let cols = [...columns];
  let objRows: Record<string, unknown>[] = rows.map((row) => {
    const obj: Record<string, unknown> = {};
    cols.forEach((c, i) => (obj[c] = row[i]));
    return obj;
  });

  for (const step of steps) {
    if (step.kind === "filter") {
      objRows = objRows.filter((row) => step.conditions.every((cond) => matchesCondition(cond, row)));
    } else if (step.kind === "computed_field") {
      if (!cols.includes(step.name)) cols = [...cols, step.name];
      objRows = objRows.map((row) => ({ ...row, [step.name]: evalExpr(step.expression, row) }));
    } else if (step.kind === "drop_fields") {
      cols = cols.filter((c) => !step.fields.includes(c));
      objRows = objRows.map((row) => {
        const next = { ...row };
        for (const f of step.fields) delete next[f];
        return next;
      });
    }
  }

  const outRows = objRows.map((row) => cols.map((c) => row[c] ?? null));
  return { columns: cols, rows: outRows };
}
