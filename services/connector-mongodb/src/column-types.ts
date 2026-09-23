import type { ColumnType } from "@nia/schemas";

/**
 * Maps a flattened column's sampled values to a real ColumnType — no
 * "unknown" fallback except when every sampled value is null/undefined
 * (nothing to infer from). Array-valued columns (per flatten.ts) are
 * always "json" regardless of content, decided by the caller before this
 * runs.
 */
export function inferColumnType(values: unknown[]): ColumnType {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (value instanceof Date) return "date";
    if (typeof value === "boolean") return "boolean";
    if (typeof value === "number") return "number";
    if (typeof value === "string") return "string";
    if (value && typeof value === "object" && "_bsontype" in value) {
      const tag = (value as { _bsontype: string })._bsontype;
      if (tag === "ObjectId" || tag === "Decimal128") return "string";
      if (tag === "Binary") return "binary";
      if (tag === "Long" || tag === "Int32" || tag === "Double") return "number";
      return "string";
    }
    return "string";
  }
  return "unknown";
}

/**
 * Single source of truth for whether a flattened column resolves to
 * ColumnType's "json" member: array-valued columns (per flatten.ts) are
 * always "json" regardless of sampled content, everything else defers to
 * inferColumnType. Callers must not re-implement this check inline —
 * having it in one typed place is what keeps "json" a real ColumnType
 * member instead of a second, ad hoc array-detection path that could
 * drift from this one.
 */
export function resolveColumnType(isArrayColumn: boolean, values: unknown[]): ColumnType {
  return isArrayColumn ? "json" : inferColumnType(values);
}

/**
 * BSON leaf values (ObjectId, Decimal128, ...) aren't JSON-serializable by
 * default in a way that survives Fastify's JSON response — stringify them
 * to their canonical text form so the tabular row's cell matches the
 * "string" ColumnType we assigned above. Real BSON Date values are left
 * untouched: Fastify's JSON serialization calls `Date.toJSON()` on them,
 * which already emits full millisecond precision (e.g.
 * "2026-09-21T00:49:40.918Z") — worker-side `to_timestamp` (not `to_date`)
 * is what now conforms timestamp-kind columns, and it preserves that
 * precision natively.
 */
export function serializeCellValue(value: unknown): unknown {
  if (value && typeof value === "object" && "_bsontype" in value) {
    const tag = (value as { _bsontype: string })._bsontype;
    if (tag === "Binary") {
      return (value as { toString: (enc: string) => string }).toString("base64");
    }
    return String(value);
  }
  return value;
}
