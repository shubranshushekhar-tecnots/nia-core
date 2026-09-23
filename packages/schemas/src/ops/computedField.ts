import { ComputedFieldStep, type ComputedFieldStep as ComputedFieldStepT } from "../nodeConfig.js";
import { buildFailureExpr } from "../expression.js";
import { typeOfExpr } from "../niaExprType.js";
import type { OpModule, SchemaResult } from "./types.js";
import { exprFnsPushable } from "./types.js";
import { evalExpr } from "./residualEval.js";
import {
  computeFailureReport,
  fallibleStepIsPushable,
  resolveOnFailure,
  rowFailed,
} from "./onFailure.js";

export const computedFieldOp: OpModule<ComputedFieldStepT> = {
  kind: "computed_field",
  schema: ComputedFieldStep as unknown as OpModule<ComputedFieldStepT>["schema"],
  residualExecution: "row-local",

  createDefault(): ComputedFieldStepT {
    return { kind: "computed_field", name: "", expression: { kind: "literal", value: "" } };
  },

  outputSchema(input, step): SchemaResult {
    // "" is a draft/autosave-transient state (same convention as
    // checkConfig below) — pass the input through unchanged rather than
    // failing on an incomplete step.
    if (step.name === "") return { ok: true, schema: input };
    const result = typeOfExpr(step.expression, input);
    if (!result.ok) return { ok: false, error: `computed field "${step.name}": ${result.error}` };
    // Always nullable: a precise nullable=false would require tracking
    // onFailure/fallible-call semantics through typeOfExpr, which the plan
    // doesn't require — over-approximating nullable is always safe, just
    // possibly imprecise.
    return { ok: true, schema: { fields: { ...input.fields, [step.name]: { type: result.type, nullable: true } } } };
  },

  isPushable(dialect, step) {
    if (!exprFnsPushable(step.expression, dialect)) return false;
    // Phase 8b-3: "null" pushes with zero new code (a failing call is
    // simply NULL and the row still passes through — exactly policy
    // "null"'s intended behavior). "drop" pushes too, via an explicit
    // WHERE NOT/$match-$not stage below (unlike filter/aggregate's
    // having, a computed_field's failing row isn't naturally excluded by
    // its SELECT-only shape, so this op adds that stage itself). "fail"
    // pushes too (Phase 9 Part 4, via pushdown.ts's
    // compileFailurePreChecks pre-check query — see onFailure.ts's top
    // doc comment). Only "quarantine" is still always forced residual —
    // see fallibleStepIsPushable (only residual execution has the source
    // row the quarantine sink needs).
    return fallibleStepIsPushable(step, step.expression);
  },

  emitSql(step, ctx) {
    ctx.addSelect(`${ctx.adapter.compileExpr(step.expression, ctx.params)} AS ${ctx.adapter.quoteIdent(step.name)}`);
    if (resolveOnFailure(step.onFailure) === "drop") {
      const failureExpr = buildFailureExpr(step.expression);
      if (failureExpr) {
        ctx.addWhere(`NOT (${ctx.adapter.compileExpr(failureExpr, ctx.params)})`);
      }
    }
  },

  emitMongo(step, ctx) {
    ctx.push({ $addFields: { [step.name]: ctx.adapter.compileExpr(step.expression) } });
    if (resolveOnFailure(step.onFailure) === "drop") {
      const failureExpr = buildFailureExpr(step.expression);
      if (failureExpr) {
        ctx.push({ $match: { $expr: { $not: [ctx.adapter.compileExpr(failureExpr)] } } });
      }
    }
  },

  transformOutputShape(step, currentShape) {
    if (currentShape && step.name) currentShape.add(step.name);
    return currentShape;
  },

  applyResidual(input, step) {
    const policy = resolveOnFailure(step.onFailure);
    const report = computeFailureReport(`computed_field "${step.name}"`, step.expression, input.rows, policy);
    const cols = input.cols.includes(step.name) ? input.cols : [...input.cols, step.name];
    const rows = input.rows.map((row) => ({ ...row, [step.name]: evalExpr(step.expression, row) }));
    // Unlike filter/aggregate's having, a computed_field's failing row
    // isn't naturally excluded by its SELECT-only shape — "drop" removes it
    // explicitly here, and "quarantine" (Phase 11) must too: a quarantined
    // row is routed to the quarantine sink instead of the normal output
    // stream, so it can't also remain in `rows`.
    if (report && (policy === "drop" || policy === "quarantine")) {
      const failureExpr = buildFailureExpr(step.expression)!;
      const kept = rows.filter((_, i) => !rowFailed(failureExpr, input.rows[i]!));
      return { cols, rows: kept, failures: [report] };
    }
    return { cols, rows, failures: report ? [report] : undefined };
  },

  checkConfig(step, ctx) {
    const messages: string[] = [];
    if (step.name === "") messages.push(`computed field step ${ctx.index + 1} has no output name.`);
    return messages;
  },
};
