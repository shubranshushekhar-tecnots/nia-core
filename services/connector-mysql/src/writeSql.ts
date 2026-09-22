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

/**
 * Schema layer, Part 4 — /create-entity's fixed CREATE TABLE template.
 * Mirrors connector-supabase/src/writeSql.ts's buildCreateTableSql, MySQL-
 * dialect: backtick identifiers, no separate `CREATE SCHEMA` statement
 * (namespace here is a MySQL database, created directly), and a composite
 * key becomes a `UNIQUE KEY` clause inside the same CREATE TABLE rather
 * than a follow-up CREATE INDEX statement (MySQL allows both; this is
 * fewer round-trips).
 */
export function buildCreateTableSql(
  entity: { namespace: string; name: string },
  columns: { name: string; nativeType: string; nullable: boolean }[],
  keyColumns: string[],
): string[] {
  const table = `${quoteIdent(entity.namespace)}.${quoteIdent(entity.name)}`;
  const colDefs = columns.map((c) => `${quoteIdent(c.name)} ${c.nativeType}${c.nullable ? "" : " NOT NULL"}`);
  if (keyColumns.length === 1) {
    colDefs.push(`PRIMARY KEY (${quoteIdent(keyColumns[0]!)})`);
  } else if (keyColumns.length > 1) {
    const idxName = `${entity.name}_nia_key_idx`.slice(0, 64);
    colDefs.push(`UNIQUE KEY ${quoteIdent(idxName)} (${keyColumns.map(quoteIdent).join(", ")})`);
  }
  return [
    `CREATE DATABASE IF NOT EXISTS ${quoteIdent(entity.namespace)}`,
    `CREATE TABLE IF NOT EXISTS ${table} (${colDefs.join(", ")})`,
  ];
}
