import type { AnyBulkWriteOperation, Document } from "mongodb";

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
 */
export function buildBulkWriteOps(
  columns: string[],
  upsertKeys: string[],
  rows: unknown[][],
): AnyBulkWriteOperation<Document>[] {
  return rows.map((row) => {
    const doc: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      doc[col] = row[i];
    });
    const filter: Record<string, unknown> = {};
    for (const key of upsertKeys) filter[key] = doc[key];
    return { replaceOne: { filter, replacement: doc, upsert: true } };
  });
}
