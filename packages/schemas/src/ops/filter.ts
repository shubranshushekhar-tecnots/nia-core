import { FilterStep, type FilterStep as FilterStepT, exprToConditions } from "../nodeConfig.js";
import { collectFieldRefs } from "../expression.js";
import type { OpModule } from "./types.js";
import { exprFnsPushable } from "./types.js";
import { evalExpr } from "./residualEval.js";
import { computeFailureReport, fallibleStepIsPushable, resolveOnFailure } from "./onFailure.js";

export const filterOp: OpModule<FilterStepT> = {
  kind: "filter",
  schema: FilterStep,
  residualExecution: "row-local",

  createDefault(): FilterStepT {
    return { kind: "filter", expr: { kind: "literal", value: true } };
  },

  outputSchema(input) {
    // filter never changes a row's shape — only which rows survive.
    return { ok: true, schema: input };
  },

  isPushable(dialect, step) {
    // Phase 8b-3: a fallible call's NULL result already excludes the row
    // via the WHERE clause under three-valued logic (null ≡ drop for
    // filter — see nodeConfig.ts's OnFailurePolicy doc comment), so
    // "null"/"drop" push normally with zero extra code. "fail" pushes too
    // (Phase 9 Part 4): pushdown.ts's compileFailurePreChecks runs a
    // separate pre-check query for every pushed fallible step, giving
    // "fail" (and "null"/"drop") a real failure count without this op
    // needing to inspect every row itself. Only "quarantine" is still
    // always forced residual (fallibleStepIsPushable) — only residual
    // execution has the source row the quarantine sink (Phase 11) needs.
    if (!fallibleStepIsPushable(step, step.expr)) return false;
    return exprFnsPushable(step.expr, dialect);
  },

  emitSql(step, ctx) {
    // Byte-identical with the pre-8b-1 output for any expr representable as
    // a flat AND-of-conditions (the only shape the editor and legacy data
    // ever produce): decompose back to FilterCondition[] and reuse the
    // original per-condition compileCondition + addWhere loop, so combineAnd
    // still wraps/joins fragments exactly as before. Only a genuinely new
    // shape (or/not/conditional — not producible by the editor) falls
    // through to a single whole-expr compileExpr call.
    const conditions = exprToConditions(step.expr);
    if (conditions) {
      for (const cond of conditions) {
        ctx.addWhere(ctx.adapter.compileCondition(cond, ctx.params));
      }
      return;
    }
    ctx.addWhere(ctx.adapter.compileExpr(step.expr, ctx.params));
  },

  emitMongo(step, ctx) {
    const conditions = exprToConditions(step.expr);
    if (conditions) {
      if (conditions.length === 0) return;
      const clauses = conditions.map((cond) => ctx.adapter.compileCondition(cond));
      const combined = ctx.adapter.combineAnd(clauses);
      if (combined) ctx.push({ $match: combined });
      return;
    }
    ctx.push({ $match: { $expr: ctx.adapter.compileExpr(step.expr) } });
  },

  applyResidual(input, step) {
    const report = computeFailureReport("filter", step.expr, input.rows, resolveOnFailure(step.onFailure));
    const rows = input.rows.filter((row) => evalExpr(step.expr, row) === true);
    return { cols: input.cols, rows, failures: report ? [report] : undefined };
  },

  checkConfig(step, ctx) {
    const messages: string[] = [];
    for (const name of collectFieldRefs(step.expr)) {
      if (name === "") {
        messages.push(`filter step ${ctx.index + 1} has a condition with no field selected.`);
      }
    }
    return messages;
  },
};
