/**
 * Phase 6 Block 2 — builds the parameterized batch UPSERT for /write.
 * Separated from index.ts so it's unit-testable without Fastify/pg.
 *
 * Identifiers (namespace/name/columns/upsertKeys) are NOT re-validated
 * here — WriteRequest's Zod schema (contract.ts's SqlIdentifier,
 * `^[A-Za-z_][A-Za-z0-9_]*$`) already rejects anything that isn't a bare
 * identifier before this function ever sees it. Every value is still
 * parameterized ($1, $2, ...) regardless — identifiers are the only thing
 * ever string-interpolated into the SQL text, and only after that schema
 * gate.
 */

function quoteIdent(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

export function buildUpsertSql(
  entity: { namespace: string; name: string },
  columns: string[],
  upsertKeys: string[],
  rowCount: number,
): string {
  const table = `${quoteIdent(entity.namespace)}.${quoteIdent(entity.name)}`;
  const colList = columns.map(quoteIdent).join(", ");

  const valueRows: string[] = [];
  let paramIndex = 1;
  for (let r = 0; r < rowCount; r++) {
    const placeholders = columns.map(() => `$${paramIndex++}`).join(", ");
    valueRows.push(`(${placeholders})`);
  }

  const conflictCols = upsertKeys.map(quoteIdent).join(", ");
  const updateCols = columns.filter((c) => !upsertKeys.includes(c));
  const conflictClause =
    updateCols.length > 0
      ? `ON CONFLICT (${conflictCols}) DO UPDATE SET ${updateCols
          .map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`)
          .join(", ")}`
      : `ON CONFLICT (${conflictCols}) DO NOTHING`;

  return `INSERT INTO ${table} (${colList}) VALUES ${valueRows.join(", ")} ${conflictClause}`;
}
