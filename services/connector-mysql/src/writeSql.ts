/**
 * Phase 6 Block 5 — builds the parameterized batch UPSERT for /write.
 * Mirrors connector-supabase/src/writeSql.ts exactly, adapted for MySQL's
 * dialect: backtick identifiers, `?` positional placeholders (mysql2's
 * convention, not Postgres's `$n`), and `ON DUPLICATE KEY UPDATE` instead
 * of `ON CONFLICT ... DO UPDATE` (MySQL has no native `DO NOTHING` — an
 * upsert-keys-only write falls back to a harmless self-assignment on the
 * first upsert key so the statement stays valid).
 *
 * Identifiers (namespace/name/columns/upsertKeys) are NOT re-validated
 * here — WriteRequest's Zod schema (contract.ts's SqlIdentifier,
 * `^[A-Za-z_][A-Za-z0-9_]*$`) already rejects anything that isn't a bare
 * identifier before this function ever sees it. Every value is still
 * parameterized (`?`) regardless — identifiers are the only thing ever
 * string-interpolated into the SQL text, and only after that schema gate.
 */

function quoteIdent(id: string): string {
  return `\`${id.replace(/`/g, "``")}\``;
}

export function buildUpsertSql(
  entity: { namespace: string; name: string },
  columns: string[],
  upsertKeys: string[],
  rowCount: number,
): string {
  const table = `${quoteIdent(entity.namespace)}.${quoteIdent(entity.name)}`;
  const colList = columns.map(quoteIdent).join(", ");

  const placeholderRow = `(${columns.map(() => "?").join(", ")})`;
  const valueRows = Array.from({ length: rowCount }, () => placeholderRow).join(", ");

  const updateCols = columns.filter((c) => !upsertKeys.includes(c));
  const updateClause =
    updateCols.length > 0
      ? updateCols.map((c) => `${quoteIdent(c)} = VALUES(${quoteIdent(c)})`).join(", ")
      : // No non-key columns to update — MySQL has no ON DUPLICATE KEY DO
        // NOTHING, so self-assign the first upsert key (harmless, keeps the
        // row's other values as originally inserted).
        `${quoteIdent(upsertKeys[0]!)} = ${quoteIdent(upsertKeys[0]!)}`;

  return `INSERT INTO ${table} (${colList}) VALUES ${valueRows} ON DUPLICATE KEY UPDATE ${updateClause}`;
}
