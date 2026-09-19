import type { TransformStep } from "../nodeConfig.js";
import type { OpKind, OpModule } from "./types.js";
import { filterOp } from "./filter.js";
import { computedFieldOp } from "./computedField.js";
import { dropFieldsOp } from "./dropFields.js";
import { aggregateOp } from "./aggregate.js";

export const OP_REGISTRY: { [K in OpKind]: OpModule<Extract<TransformStep, { kind: K }>> } = {
  filter: filterOp,
  computed_field: computedFieldOp,
  drop_fields: dropFieldsOp,
  aggregate: aggregateOp,
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
