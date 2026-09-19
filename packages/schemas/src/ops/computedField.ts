import { ComputedFieldStep, type ComputedFieldStep as ComputedFieldStepT } from "../nodeConfig.js";
import type { OpModule } from "./types.js";
import { evalExpr } from "./residualEval.js";

export const computedFieldOp: OpModule<ComputedFieldStepT> = {
  kind: "computed_field",
  schema: ComputedFieldStep as unknown as OpModule<ComputedFieldStepT>["schema"],

  createDefault(): ComputedFieldStepT {
    return { kind: "computed_field", name: "", expression: { kind: "literal", value: "" } };
  },

  isPushable() {
    return true;
  },

  emitSql(step, ctx) {
    ctx.addSelect(`${ctx.adapter.compileExpr(step.expression, ctx.params)} AS ${ctx.adapter.quoteIdent(step.name)}`);
  },

  emitMongo(step, ctx) {
    ctx.push({ $addFields: { [step.name]: ctx.adapter.compileExpr(step.expression) } });
  },

  transformOutputShape(step, currentShape) {
    if (currentShape && step.name) currentShape.add(step.name);
    return currentShape;
  },

  applyResidual(input, step) {
    const cols = input.cols.includes(step.name) ? input.cols : [...input.cols, step.name];
    const rows = input.rows.map((row) => ({ ...row, [step.name]: evalExpr(step.expression, row) }));
    return { cols, rows };
  },

  checkConfig(step, ctx) {
    if (step.name === "") return [`computed field step ${ctx.index + 1} has no output name.`];
    return [];
  },
};
