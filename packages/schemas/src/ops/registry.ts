import type { TransformStep } from "../nodeConfig.js";
import type { NiaSchema } from "../niaType.js";
import type { OpKind, OpModule, SchemaResult } from "./types.js";
import { filterOp } from "./filter.js";
import { computedFieldOp } from "./computedField.js";
import { dropFieldsOp } from "./dropFields.js";
import { aggregateOp } from "./aggregate.js";
import { toJsonOp } from "./toJson.js";
import { flattenOp } from "./flatten.js";

export const OP_REGISTRY: { [K in OpKind]: OpModule<Extract<TransformStep, { kind: K }>> } = {
  filter: filterOp,
  computed_field: computedFieldOp,
  drop_fields: dropFieldsOp,
  aggregate: aggregateOp,
  to_json: toJsonOp,
  flatten: flattenOp,
};

export function getOp<K extends OpKind>(kind: K): OpModule<Extract<TransformStep, { kind: K }>> {
  return OP_REGISTRY[kind];
}

/**
 * Looks up a step's op module, typed against that step's own concrete
 * type rather than the full TransformStep union. Callers iterating a
 * generic `step: TransformStep` and invoking `OP_REGISTRY[step.kind]`
 * directly hit TypeScript's known "calling a union of function types"
 * limitation (the call's parameter type collapses to the intersection of
 * every union member's parameter type, which is `never` here since each
 * op's `kind` literal differs) — this helper's single internal cast
 * avoids that at every call site instead of repeating the workaround.
 */
export function opForStep<T extends TransformStep>(step: T): OpModule<T> {
  return OP_REGISTRY[step.kind] as unknown as OpModule<T>;
}

/**
 * Folds a source NiaSchema through every step's own `outputSchema` in
 * order, producing the pipeline's real POST-transform output schema — the
 * shape a destination contract must actually be built against (destination
 * mapping `from` paths name the transform graph's OUTPUT fields, not
 * necessarily the raw source's own fields: an Aggregate alias or a
 * computed_field that overwrites/introduces a field only exists after its
 * step runs). Short-circuits on the first step whose outputSchema fails,
 * returning that same `{ok:false, error}` unchanged — same "fail naming
 * the field, never guess" bar every op's own outputSchema already sets
 * (see e.g. computedField.ts/aggregate.ts's outputSchema doc comments).
 * `steps` is expected to be every TransformStep on the path from source to
 * destination, in execution order, across however many transform nodes sit
 * between them (pushed vs residual doesn't matter here — outputSchema is a
 * pure design-time shape computation, independent of where a step actually
 * executes at runtime).
 */
export function compileTransformOutputSchema(source: NiaSchema, steps: TransformStep[]): SchemaResult {
  let schema = source;
  for (const step of steps) {
    const result = opForStep(step).outputSchema(schema, step);
    if (!result.ok) return result;
    schema = result.schema;
  }
  return { ok: true, schema };
}
