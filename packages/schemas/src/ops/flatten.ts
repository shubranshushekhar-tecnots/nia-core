import { FlattenStep, type FlattenStep as FlattenStepT } from "../nodeConfig.js";
import type { NiaField, NiaTypeObject } from "../niaType.js";
import type { OpModule, QuarantinedRow, SchemaResult, StepFailureReport } from "./types.js";

/**
 * Schema-time expansion of an object-typed NiaField's own fields into
 * `${prefix}_${key}`-named NiaFields (underscore, not dot — matching
 * niaInference.ts's normalizeFieldName convention that nested paths
 * ultimately normalize to underscore-joined destination column names).
 * `remainingDepth` bounds recursion the same way FlattenStepT.maxDepth
 * does at the top call (maxDepth=1 -> remainingDepth=0 here, i.e. only
 * the object's immediate children are expanded; a nested object beyond
 * that stays as a single object-typed field under its own prefixed name).
 * A child's `nullable` inherits its parent's (an absent/null parent object
 * makes every one of its children absent too).
 */
function flattenObjectFields(prefix: string, obj: NiaTypeObject, parentNullable: boolean, remainingDepth: number): Record<string, NiaField> {
  const out: Record<string, NiaField> = {};
  for (const [key, field] of Object.entries(obj.fields)) {
    const name = `${prefix}_${key}`;
    const nullable = field.nullable || parentNullable;
    if (remainingDepth > 0 && field.type.kind === "object") {
      Object.assign(out, flattenObjectFields(name, field.type, nullable, remainingDepth - 1));
    } else {
      out[name] = { ...field, nullable };
    }
  }
  return out;
}

/** Thrown internally by flattenObjectValue and caught per-row by applyResidual below — never escapes this file. Carries just enough to build a QuarantinedRow at the catch site (applyResidual has the full source row; this function only ever sees the target field's own sub-value). */
class FlattenNonObjectError extends Error {
  constructor(readonly value: unknown) {
    super("flatten: non-object value");
  }
}

/**
 * Runtime counterpart of flattenObjectFields, applied to one row's actual
 * value. `null`/`undefined` contribute no keys (a legitimate "no value" —
 * already accounted for by nullable in the design-time schema). A non-null
 * value that isn't a plain object (a string/number/boolean/array — the
 * "degraded field, mixed shape" case) THROWS a FlattenNonObjectError rather
 * than silently contributing no keys: design-time schema (Part 2's
 * profiler-sample inference) types a genuinely mixed-shape field as
 * "json"/degraded, not "object", so outputSchema already refuses to flatten
 * it — see this file's outputSchema. But that guarantee is only as good as
 * the sample: a live row outside the profiled sample can still turn out
 * non-object even when every sampled row was an object. Silently emitting
 * no keys for such a row would make its flattened columns read as NULL,
 * indistinguishable from a genuinely absent/null field — exactly the "must
 * not silently become NULLs" case this function must not produce.
 *
 * Schema layer, Part 5: this used to throw ResidualAbortError, aborting the
 * whole run. Now the whole ROW is quarantined and counted instead (like any
 * other fallible row) — see applyResidual's catch site below, which turns
 * this exception into a QuarantinedRow with fn "flatten_non_object" (no
 * real CallFn represents "value wasn't an object" — see QuarantinedRow.fn's
 * doc comment in types.ts) and drops just that row from this step's output.
 * FlattenStep has no `onFailure` config (nodeConfig.ts's FlattenStep doc
 * comment) — this failure mode is always quarantine, not configurable.
 */
function flattenObjectValue(prefix: string, value: unknown, remainingDepth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value === null || value === undefined) return out;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new FlattenNonObjectError(value);
  }
  for (const [key, sub] of Object.entries(value as Record<string, unknown>)) {
    const name = `${prefix}_${key}`;
    if (remainingDepth > 0 && sub !== null && typeof sub === "object" && !Array.isArray(sub)) {
      Object.assign(out, flattenObjectValue(name, sub, remainingDepth - 1));
    } else {
      out[name] = sub;
    }
  }
  return out;
}

/**
 * Schema layer, Part 3 — flatten(field, maxDepth). Non-pushable on every
 * dialect for now (residual only); pushdown support is TODO.md-tracked,
 * not implemented here. See FlattenStep's doc comment (nodeConfig.ts) for
 * the step shape.
 */
export const flattenOp: OpModule<FlattenStepT> = {
  kind: "flatten",
  schema: FlattenStep,
  residualExecution: "row-local",

  createDefault(): FlattenStepT {
    return { kind: "flatten", field: "", maxDepth: 1 };
  },

  outputSchema(input, step): SchemaResult {
    // "" is a draft/autosave-transient state (same convention as
    // checkConfig below) — pass the input through unchanged.
    if (step.field === "") return { ok: true, schema: input };
    const src = input.fields[step.field];
    if (!src) return { ok: false, error: `flatten step: unknown field "${step.field}".` };
    if (src.type.kind !== "object") {
      return {
        ok: false,
        error: `flatten step: field "${step.field}" is type "${src.type.kind}", not "object" — its nested fields can't be determined without guessing.`,
      };
    }
    const flattened = flattenObjectFields(step.field, src.type, src.nullable, Math.max(0, step.maxDepth - 1));
    const fields = { ...input.fields };
    delete fields[step.field];
    for (const [name, field] of Object.entries(flattened)) {
      if (name in fields) {
        return {
          ok: false,
          error: `flatten step: field "${step.field}" flattening produces a column name "${name}" that collides with an existing column.`,
        };
      }
      fields[name] = field;
    }
    return { ok: true, schema: { fields } };
  },

  isPushable() {
    // Not yet implemented on any dialect — see TODO.md.
    return false;
  },

  // No emitSql/emitMongo — never pushable today.

  applyResidual(input, step) {
    if (step.field === "") return { cols: input.cols, rows: input.rows };
    const remainingDepth = Math.max(0, step.maxDepth - 1);
    const rows: Record<string, unknown>[] = [];
    const quarantinedRows: QuarantinedRow[] = [];
    for (const row of input.rows) {
      const { [step.field]: target, ...rest } = row;
      try {
        rows.push({ ...rest, ...flattenObjectValue(step.field, target, remainingDepth) });
      } catch (err) {
        if (!(err instanceof FlattenNonObjectError)) throw err;
        // Schema layer, Part 5: quarantine the whole row (not just the
        // flatten field) and drop it from this step's output — see
        // flattenObjectValue's doc comment above for why this is no longer
        // a run-abort.
        quarantinedRows.push({ fn: "flatten_non_object", inputValue: err.value, sourceRow: row });
      }
    }
    // Union the flattened key set across every row (not just row[0]) —
    // rows sourced from loosely-typed data (Mongo, JSON) can genuinely
    // produce different flattened keys per row.
    const extraCols = new Set<string>();
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (!input.cols.includes(key) || key === step.field) extraCols.add(key);
      }
    }
    extraCols.delete(step.field);
    const cols = [...input.cols.filter((c) => c !== step.field), ...extraCols];
    const failures: StepFailureReport[] | undefined =
      quarantinedRows.length > 0
        ? [
            {
              label: `flatten "${step.field}"`,
              fns: ["flatten_non_object"],
              policy: "quarantine",
              count: quarantinedRows.length,
              quarantinedRows,
            },
          ]
        : undefined;
    return { cols, rows, failures };
  },

  checkConfig(step, ctx) {
    const messages: string[] = [];
    if (step.field === "") messages.push(`flatten step ${ctx.index + 1} has no field selected.`);
    if (!Number.isInteger(step.maxDepth) || step.maxDepth < 1) {
      messages.push(`flatten step ${ctx.index + 1} has an invalid maxDepth; must be a positive integer.`);
    }
    return messages;
  },
};
