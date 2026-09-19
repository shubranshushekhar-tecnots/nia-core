import { FilterStep, type FilterStep as FilterStepT, exprToConditions } from "../nodeConfig.js";
import { collectFieldRefs } from "../expression.js";
import type { OpModule } from "./types.js";
import { evalExpr } from "./residualEval.js";

export const filterOp: OpModule<FilterStepT> = {
  kind: "filter",
  schema: FilterStep,

  createDefault(): FilterStepT {
    return { kind: "filter", expr: { kind: "literal", value: true } };
  },

  isPushable() {
    return true;
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
    return { cols: input.cols, rows: input.rows.filter((row) => evalExpr(step.expr, row) === true) };
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
