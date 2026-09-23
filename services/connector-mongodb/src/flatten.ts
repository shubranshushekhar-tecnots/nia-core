/**
 * Deterministic document -> tabular-row flattening.
 *
 * Rule (fixed, see the six-changes review that required this be nailed down
 * before writing code):
 *   - Only plain objects (non-array, non-null `object` values) are
 *     recursively descended into, building dotted-path column names
 *     (e.g. `{ a: { b: 1 } }` -> column `a.b`).
 *   - Arrays are NEVER descended into, regardless of what they contain
 *     (scalars, objects, or nested arrays) — the whole array is
 *     JSON.stringify'd into a single column value, typed "json". This
 *     avoids the non-determinism of index-based column names (arrays
 *     vary in length across documents) and avoids silently dropping data
 *     when array shapes differ between documents.
 *   - The column set for a result set is the union of every dotted path
 *     seen across all documents, sorted alphabetically — so column order
 *     never depends on which document happened to be processed first.
 *   - A document missing a given path gets `null` for that column.
 *   - A field name that itself contains a literal "." is ambiguous — its
 *     dotted-path column can't be told apart from a genuinely nested
 *     field with the same path. Rather than guess, that key's whole
 *     subtree stops descending right there (any object/array value under
 *     it is JSON.stringify'd as-is, not merged into further dotted
 *     columns) and the resulting column is flagged in `degradedColumns`
 *     — callers (schema/mapping UI, and the write-side un-flatten in
 *     writeOps.ts) should treat it as a single opaque field, not
 *     something safe to split on ".".
 */

export type FlattenedRow = Record<string, unknown>;

/**
 * BSON leaf types (ObjectId, Decimal128, Binary, Long, Timestamp, ...) are
 * `typeof === "object"` but must never be descended into — they're opaque
 * scalar values from the tabular shape's point of view. The driver tags
 * every one of them with `_bsontype`.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !("_bsontype" in value)
  );
}

function flattenDocument(
  doc: Record<string, unknown>,
  arrayColumns: Set<string>,
  degradedColumns: Set<string>,
  prefix = "",
): FlattenedRow {
  const out: FlattenedRow = {};
  for (const [key, value] of Object.entries(doc)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (key.includes(".")) {
      // Ambiguous: this key's own dotted path can't be distinguished from
      // a genuinely nested field of the same name — stop descending here
      // instead of guessing, and flag the resulting column.
      degradedColumns.add(path);
      if (Array.isArray(value)) {
        out[path] = JSON.stringify(value);
        arrayColumns.add(path);
      } else if (isPlainObject(value)) {
        out[path] = JSON.stringify(value);
      } else {
        out[path] = value;
      }
      continue;
    }
    if (Array.isArray(value)) {
      out[path] = JSON.stringify(value);
      arrayColumns.add(path);
    } else if (isPlainObject(value)) {
      Object.assign(out, flattenDocument(value, arrayColumns, degradedColumns, path));
    } else {
      out[path] = value;
    }
  }
  return out;
}

export type FlattenedResult = {
  columns: string[];
  /** Columns whose value is a JSON.stringify'd array — caller should type these "json", not infer from the value. */
  arrayColumns: Set<string>;
  /** Columns built from a field name that itself contains a literal "." — ambiguous with a genuinely nested path of the same name; callers must not treat these as splittable dotted paths. */
  degradedColumns: Set<string>;
  rows: FlattenedRow[];
};

export function flattenDocuments(docs: Record<string, unknown>[]): FlattenedResult {
  const arrayColumns = new Set<string>();
  const degradedColumns = new Set<string>();
  const flatRows = docs.map((d) => flattenDocument(d, arrayColumns, degradedColumns));
  const columnSet = new Set<string>();
  for (const row of flatRows) {
    for (const col of Object.keys(row)) columnSet.add(col);
  }
  const columns = [...columnSet].sort();
  const rows = flatRows.map((row) => {
    const normalized: FlattenedRow = {};
    for (const col of columns) normalized[col] = col in row ? row[col] : null;
    return normalized;
  });
  return { columns, arrayColumns, degradedColumns, rows };
}
