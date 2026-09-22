import type { AnyBulkWriteOperation, Document } from "mongodb";

/**
 * A value survives the wire as whatever flatten.ts produced it as: an
 * array gets JSON.stringify'd (see flatten.ts's header comment), so its
 * mirror image here is "does this string parse as a JSON array" — the
 * exact inverse check, not a general JSON.parse-everything coercion (a
 * plain string column that happens to look like `"123"` or `"null"`
 * should stay a string). WriteRequest carries no column-type metadata
 * (see writeValueCoercion.ts's header comment for why the SQL connectors
 * hit the same gap), so this is the only signal available at write time
 * for a Mongo destination — deliberately narrow (arrays only) to match
 * flatten.ts's own narrow "only arrays get stringified" rule exactly.
 */
function maybeParseJsonArray(value: unknown): unknown {
  if (typeof value !== "string") return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  return Array.isArray(parsed) ? parsed : value;
}

/**
 * Inverse of flatten.ts's dotted-path flattening: splits each column name
 * on "." and rebuilds the nested document shape, so a Mongo source that
 * got flattened for the tabular pipeline (`{a: {b: 1}}` -> column `a.b`)
 * comes back out the same shape on a Mongo destination, instead of a
 * column literally named "a.b" landing as a single field.
 *
 * This is a mechanical, name-only inversion — it always splits on "."
 * unconditionally. It cannot know which columns flatten.ts flagged
 * `degraded` (a source field name that itself contained a literal "."),
 * because WriteRequest only carries column name strings, not that flag —
 * same contract gap as above. That ambiguity is inherent to a flat
 * column-name convention and is exactly why flatten.ts flags it at read
 * time instead of guessing: a mapping built on a degraded column is a
 * known, surfaced limitation, not something the write side can silently
 * repair.
 */
function setNestedPath(doc: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cursor = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const existing = cursor[part];
    if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

function unflattenDoc(columns: string[], row: unknown[]): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  columns.forEach((col, i) => {
    setNestedPath(doc, col, maybeParseJsonArray(row[i]));
  });
  return doc;
}

/**
 * Phase 6 Block 5 — builds the batch upsert for /write. Mongo's dialect
 * equivalent of connector-mysql/connector-supabase's buildUpsertSql: instead
 * of parameterized SQL text, this produces a `bulkWrite` operations array —
 * one `replaceOne` per row, filtered on `upsertKeys` (matching WriteRequest's
 * positional columns/rows convention), `upsert: true` so a non-matching
 * filter inserts instead of no-oping. A full-document replaceOne (not
 * updateOne+$set) is used deliberately: it makes the write idempotent under
 * retry the same way the SQL dialects' upserts are — replaying the same
 * batch produces the same document, not an ever-growing merge of stale and
 * fresh fields.
 *
 * The filter deliberately keys off the original dotted column name (Mongo
 * query filters support "." dot-notation natively against a nested
 * document), not a value read back out of the rebuilt nested
 * `replacement` — simpler than re-walking the nested doc, and correct for
 * exactly the same reason `replacement` is correct.
 */
export function buildBulkWriteOps(
  columns: string[],
  upsertKeys: string[],
  rows: unknown[][],
): AnyBulkWriteOperation<Document>[] {
  return rows.map((row) => {
    const replacement = unflattenDoc(columns, row);
    const filter: Record<string, unknown> = {};
    for (const key of upsertKeys) {
      const i = columns.indexOf(key);
      filter[key] = maybeParseJsonArray(row[i]);
    }
    return { replaceOne: { filter, replacement, upsert: true } };
  });
}
