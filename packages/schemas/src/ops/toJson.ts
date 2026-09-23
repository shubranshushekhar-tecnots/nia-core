import { ToJsonStep, type ToJsonStep as ToJsonStepT } from "../nodeConfig.js";
import type { OpModule, SchemaResult } from "./types.js";

/**
 * Schema layer, Part 3 — to_json(field) -> outputName. Non-pushable on
 * every dialect for now (residual only); pushdown support is TODO.md-
 * tracked, not implemented here. See ToJsonStep's doc comment
 * (nodeConfig.ts) for the step shape.
 */
export const toJsonOp: OpModule<ToJsonStepT> = {
  kind: "to_json",
  schema: ToJsonStep,
  residualExecution: "row-local",

  createDefault(): ToJsonStepT {
    return { kind: "to_json", field: "", outputName: "" };
  },

  outputSchema(input, step): SchemaResult {
    // "" is a draft/autosave-transient state (same convention as
    // checkConfig below) — pass the input through unchanged.
    if (step.field === "" || step.outputName === "") return { ok: true, schema: input };
    const src = input.fields[step.field];
    if (!src) return { ok: false, error: `to_json step: unknown field "${step.field}".` };
    return {
      ok: true,
      schema: { fields: { ...input.fields, [step.outputName]: { type: { kind: "json" }, nullable: src.nullable } } },
    };
  },

  isPushable() {
    // Not yet implemented on any dialect — see TODO.md.
    return false;
  },

  // No emitSql/emitMongo — never pushable today.

  transformOutputShape(step, currentShape) {
    if (currentShape && step.field && step.outputName) currentShape.add(step.outputName);
    return currentShape;
  },

  applyResidual(input, step) {
    if (step.field === "" || step.outputName === "") return { cols: input.cols, rows: input.rows };
    const cols = input.cols.includes(step.outputName) ? input.cols : [...input.cols, step.outputName];
    const rows = input.rows.map((row) => ({ ...row, [step.outputName]: row[step.field] }));
    return { cols, rows };
  },

  checkConfig(step, ctx) {
    const messages: string[] = [];
    if (step.field === "") messages.push(`to_json step ${ctx.index + 1} has no field selected.`);
    if (step.outputName === "") messages.push(`to_json step ${ctx.index + 1} has no output name.`);
    return messages;
  },
};
