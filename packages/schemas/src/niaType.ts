import { z } from "zod";

/**
 * Schema layer, Part 1 — NiaType: the one closed logical type system every
 * connector's dialect adapter translates to/from (niaAdapters.ts), so N
 * sources + M destinations need N + M mappings instead of N × M. See
 * docs/plans/schema-layer.md for the full design.
 *
 * Deliberately closed (no dialect-specific escape hatch member beyond
 * "json", which is itself a first-class NiaType, not an any-type). Adding a
 * twelfth kind is a real, considered schema-layer change — not something
 * an adapter should do unilaterally by inventing a new string.
 */
export const NiaTypeKind = z.enum([
  "string",
  "integer",
  "float",
  "decimal",
  "boolean",
  "date",
  "timestamp",
  "bytes",
  "json",
  "object",
  "array",
]);
export type NiaTypeKind = z.infer<typeof NiaTypeKind>;

export const StringFormat = z.enum(["uuid", "objectId"]);
export type StringFormat = z.infer<typeof StringFormat>;

export const TimestampTz = z.enum(["utc", "naive"]);
export type TimestampTz = z.infer<typeof TimestampTz>;

export interface NiaTypeString {
  kind: "string";
  format?: StringFormat;
}
export interface NiaTypeInteger {
  kind: "integer";
}
export interface NiaTypeFloat {
  kind: "float";
}
export interface NiaTypeDecimal {
  kind: "decimal";
  precision?: number;
  scale?: number;
}
export interface NiaTypeBoolean {
  kind: "boolean";
}
export interface NiaTypeDate {
  kind: "date";
}
export interface NiaTypeTimestamp {
  kind: "timestamp";
  tz: TimestampTz;
}
export interface NiaTypeBytes {
  kind: "bytes";
}
export interface NiaTypeJson {
  kind: "json";
}
export interface NiaTypeObject {
  kind: "object";
  fields: Record<string, NiaField>;
}
export interface NiaTypeArray {
  kind: "array";
  element: NiaType;
}

export type NiaType =
  | NiaTypeString
  | NiaTypeInteger
  | NiaTypeFloat
  | NiaTypeDecimal
  | NiaTypeBoolean
  | NiaTypeDate
  | NiaTypeTimestamp
  | NiaTypeBytes
  | NiaTypeJson
  | NiaTypeObject
  | NiaTypeArray;

/** Every field carries nullable; inferred fields also carry presence (0-1, the fraction of sampled records that have the field at all — see niaInference.ts). Declared (SQL-source) fields never set presence: a declared column always structurally exists. */
export interface NiaField {
  type: NiaType;
  nullable: boolean;
  presence?: number;
}

export const NiaTypeSchema: z.ZodType<NiaType> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("string"), format: StringFormat.optional() }),
    z.object({ kind: z.literal("integer") }),
    z.object({ kind: z.literal("float") }),
    z.object({ kind: z.literal("decimal"), precision: z.number().int().positive().optional(), scale: z.number().int().nonnegative().optional() }),
    z.object({ kind: z.literal("boolean") }),
    z.object({ kind: z.literal("date") }),
    z.object({ kind: z.literal("timestamp"), tz: TimestampTz }),
    z.object({ kind: z.literal("bytes") }),
    z.object({ kind: z.literal("json") }),
    z.object({ kind: z.literal("object"), fields: z.record(z.string(), NiaFieldSchemaRef()) }),
    z.object({ kind: z.literal("array"), element: NiaTypeSchemaRef() }),
  ]),
);

// z.lazy() closures below need to reference the not-yet-initialized consts
// above them — small indirection so the mutual recursion (NiaType <->
// NiaField) type-checks without reordering the exports.
function NiaTypeSchemaRef(): z.ZodType<NiaType> {
  return NiaTypeSchema;
}
function NiaFieldSchemaRef(): z.ZodType<NiaField> {
  return NiaFieldSchema;
}

export const NiaFieldSchema: z.ZodType<NiaField> = z.lazy(() =>
  z.object({
    type: NiaTypeSchema,
    nullable: z.boolean(),
    presence: z.number().min(0).max(1).optional(),
  }),
);

/** An entity's shape: field name (or, for inferred sources, a dotted path — see niaInference.ts) -> NiaField. */
export const NiaSchema = z.object({
  fields: z.record(z.string(), NiaFieldSchema),
});
export type NiaSchema = z.infer<typeof NiaSchema>;

export interface JoinResult {
  type: NiaType;
  /** True when this join lost information — fell back to "string" (scalar clash) or "json" (structural clash), or joined two structurally-incompatible object/array shapes. False for every explicitly-modeled widening (integer⊔float, date⊔timestamp, same-kind merges, object⊔object, array⊔array). */
  degraded: boolean;
  reason: string | null;
}

const NUMERIC_RANK: Record<"integer" | "float" | "decimal", number> = {
  integer: 0,
  float: 1,
  decimal: 2,
};

function isStructural(t: NiaType): boolean {
  return t.kind === "json" || t.kind === "object" || t.kind === "array";
}

/** The escape-hatch kind a fallback join lands on: "json" if either side is structural (object/array/json — losing that shape is worse than losing scalar precision), else "string" (the universal scalar rendering). */
function fallbackKind(a: NiaType, b: NiaType): "string" | "json" {
  return isStructural(a) || isStructural(b) ? "json" : "string";
}

/**
 * Every join that isn't one of the explicitly-modeled widenings above
 * (same-kind merge, the numeric/temporal ladders, object⊔object,
 * array⊔array) is a fallback, and is always marked degraded — including
 * json⊔object/array, which could arguably be framed as "json already IS
 * the any-type, no information lost." Not modeled that way here: the
 * plan's closed rule set only names the ladders/merges above as lossless,
 * so a shape landing on "json" via a path other than array⊔array or
 * object⊔object still reports degraded, keeping "degraded" a simple,
 * total "did this take a path other than the explicitly modeled ones"
 * check rather than a second judgment call per kind pair.
 */
function fallback(a: NiaType, b: NiaType, reason: string): JoinResult {
  const kind = fallbackKind(a, b);
  return { type: { kind }, degraded: true, reason };
}

/**
 * The type join: what a field's NiaType becomes when two observed/declared
 * shapes for it meet (folding a profiler sample, or merging a contract
 * with newly-observed structure). Pure, total, symmetric. Nullability is
 * NOT part of this function's domain — join() only ever receives concrete
 * NiaTypes; "anything ⊔ null" (a value slot with no observed type at all)
 * is handled by joinField()/joinNullable() below, which wrap this.
 */
export function join(a: NiaType, b: NiaType): JoinResult {
  // Exact same scalar kind (no nested state to merge): trivially lossless.
  if (a.kind === b.kind && a.kind !== "decimal" && a.kind !== "object" && a.kind !== "array" && a.kind !== "string" && a.kind !== "timestamp") {
    return { type: a, degraded: false, reason: null };
  }

  if (a.kind === "string" && b.kind === "string") {
    const af = a.format;
    const bf = b.format;
    const format = af && bf && af === bf ? af : undefined;
    return { type: { kind: "string", format }, degraded: false, reason: null };
  }

  if (a.kind === "decimal" && b.kind === "decimal") {
    const precision = a.precision === b.precision ? a.precision : undefined;
    const scale = a.scale === b.scale ? a.scale : undefined;
    return { type: { kind: "decimal", precision, scale }, degraded: false, reason: null };
  }

  if (a.kind === "timestamp" && b.kind === "timestamp") {
    const tz = a.tz === b.tz ? a.tz : "naive";
    return { type: { kind: "timestamp", tz }, degraded: false, reason: null };
  }

  // Numeric ladder: integer ⊔ float = float; integer|float ⊔ decimal = decimal.
  if (a.kind in NUMERIC_RANK && b.kind in NUMERIC_RANK) {
    const ak = a.kind as keyof typeof NUMERIC_RANK;
    const bk = b.kind as keyof typeof NUMERIC_RANK;
    const winner = NUMERIC_RANK[ak] >= NUMERIC_RANK[bk] ? a : b;
    if (winner.kind === "decimal") {
      const other = winner === a ? b : a;
      if (other.kind === "decimal") {
        const precision = winner.precision === other.precision ? winner.precision : undefined;
        const scale = winner.scale === other.scale ? winner.scale : undefined;
        return { type: { kind: "decimal", precision, scale }, degraded: false, reason: null };
      }
      return { type: winner, degraded: false, reason: null };
    }
    return { type: { kind: "float" }, degraded: false, reason: null };
  }

  // Temporal ladder: date ⊔ timestamp = timestamp (inherit the timestamp side's tz).
  if ((a.kind === "date" && b.kind === "timestamp") || (a.kind === "timestamp" && b.kind === "date")) {
    const ts = (a.kind === "timestamp" ? a : b) as NiaTypeTimestamp;
    return { type: { kind: "timestamp", tz: ts.tz }, degraded: false, reason: null };
  }

  // object ⊔ object = merged fields.
  if (a.kind === "object" && b.kind === "object") {
    const keys = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)]);
    const fields: Record<string, NiaField> = {};
    let firstDegradedKey: string | null = null;
    let firstReason: string | null = null;
    for (const key of keys) {
      const af = a.fields[key];
      const bf = b.fields[key];
      const merged = joinField(af ?? null, bf ?? null);
      fields[key] = merged.field;
      if (merged.degraded && firstDegradedKey === null) {
        firstDegradedKey = key;
        firstReason = merged.reason;
      }
    }
    return {
      type: { kind: "object", fields },
      degraded: firstDegradedKey !== null,
      reason: firstDegradedKey !== null ? `object field "${firstDegradedKey}" degraded: ${firstReason}` : null,
    };
  }

  // array<A> ⊔ array<B> = array<A ⊔ B> — degraded-ness propagates from the element join, arrays-of-arrays never themselves count as a structural clash.
  if (a.kind === "array" && b.kind === "array") {
    const inner = join(a.element, b.element);
    return {
      type: { kind: "array", element: inner.type },
      degraded: inner.degraded,
      reason: inner.reason,
    };
  }

  return fallback(a, b, `"${a.kind}" and "${b.kind}" have no common representation`);
}

export interface FieldJoinResult {
  field: NiaField;
  degraded: boolean;
  reason: string | null;
}

/**
 * "anything ⊔ null = nullable" plus the object-merge case where a key is
 * present in only one side's shape. `null` here means "no field at this
 * slot" (absent from one side, or — for a single value's fold, see
 * niaInference.ts — no non-null value observed yet), not NiaType's own
 * "json"/"string" fallback kinds.
 */
export function joinField(a: NiaField | null, b: NiaField | null): FieldJoinResult {
  if (a === null && b === null) {
    // Never actually reached by object-merge (a key only ends up in the
    // union if it came from at least one side) but kept total for
    // niaInference.ts's per-value fold, which starts from "nothing seen yet".
    return { field: { type: { kind: "json" }, nullable: true, presence: 0 }, degraded: false, reason: null };
  }
  if (a === null) return { field: { ...b!, nullable: true }, degraded: false, reason: null };
  if (b === null) return { field: { ...a, nullable: true }, degraded: false, reason: null };

  const result = join(a.type, b.type);
  const presence = a.presence === undefined && b.presence === undefined ? undefined : (a.presence ?? 1) === (b.presence ?? 1) ? a.presence ?? b.presence : undefined;
  return {
    field: { type: result.type, nullable: a.nullable || b.nullable, presence },
    degraded: result.degraded,
    reason: result.reason,
  };
}
