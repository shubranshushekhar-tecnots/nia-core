import { DropFieldsStep, type DropFieldsStep as DropFieldsStepT } from "../nodeConfig.js";
import type { OpModule, SourceDialect } from "./types.js";

export const dropFieldsOp: OpModule<DropFieldsStepT> = {
  kind: "drop_fields",
  schema: DropFieldsStep,

  createDefault(): DropFieldsStepT {
    return { kind: "drop_fields", fields: [] };
  },

  isPushable(dialect: SourceDialect, _step: DropFieldsStepT) {
    // Native field-exclusion projection ($project: {f: 0}) only exists in
    // Mongo's aggregation framework. Plain SQL has no "SELECT * EXCEPT
    // (col)" — expressing this would require enumerating every *kept*
    // column, which needs the full schema. Real, disclosed asymmetry.
    return dialect === "mongo";
  },

  // No emitSql — never SQL-pushable.

  emitMongo(step, ctx) {
    if (step.fields.length === 0) return;
    ctx.push({ $project: Object.fromEntries(step.fields.map((f) => [f, 0])) });
  },

  transformOutputShape(step, currentShape) {
    if (currentShape) for (const f of step.fields) currentShape.delete(f);
    return currentShape;
  },

  applyResidual(input, step) {
    const cols = input.cols.filter((c) => !step.fields.includes(c));
    const rows = input.rows.map((row) => {
      const next = { ...row };
      for (const f of step.fields) delete next[f];
      return next;
    });
    return { cols, rows };
  },
};
