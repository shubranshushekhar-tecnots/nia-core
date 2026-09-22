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

  // Check item 1 (identity columns): same GENERATED ALWAYS AS IDENTITY gap
  // as stagingSql.ts's buildStagingUpsertSql/buildApplyFromStagingSql, here
  // for the "direct" (non-staged) write mode's INSERT straight into dest.
  // Unconditional and always safe — confirmed live against dev-postgres
  // that OVERRIDING SYSTEM VALUE is a no-op on a plain column, a GENERATED
  // BY DEFAULT column, and when the identity column isn't in the list.
  return `INSERT INTO ${table} (${colList}) OVERRIDING SYSTEM VALUE VALUES ${valueRows.join(", ")} ${conflictClause}`;
}

/**
 * Schema layer, Part 4 — /create-entity's fixed CREATE TABLE template.
 * `columns[].nativeType` is already-resolved dialect-native DDL text from
 * niaAdapters.ts's fromNiaType() (worker-side); this function interpolates
 * it verbatim, same "connector builds from a fixed template, never raw
 * caller SQL" posture as buildUpsertSql above — only identifiers
 * (namespace/name/column names/key columns) are ever caller-controlled
 * text, and those are already SqlIdentifier-validated by CreateEntityRequest
 * before this is called. Idempotent (`IF NOT EXISTS` throughout): the
 * caller (destinationContract.ts's compareContractToExisting, run from
 * runEtl.ts) already confirmed the entity didn't exist before dispatching
 * this, but IF NOT EXISTS keeps it safe against a redelivered first-chunk
 * job racing a concurrent create. A single key column becomes an inline
 * PRIMARY KEY; a composite key becomes a UNIQUE INDEX instead (Part 4's
 * "Keys become the primary key or a unique index" bullet) since this
 * codebase's keyset-pagination/upsert paths elsewhere already treat
 * composite keys as "no single orderable PK", not as a schema error.
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
  }
  const statements = [
    `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(entity.namespace)}`,
    `CREATE TABLE IF NOT EXISTS ${table} (${colDefs.join(", ")})`,
  ];
  if (keyColumns.length > 1) {
    const idxName = `${entity.name}_nia_key_idx`.slice(0, 63);
    statements.push(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdent(idxName)} ON ${table} (${keyColumns.map(quoteIdent).join(", ")})`,
    );
  }
  return statements;
}

/** Part 4's "If anon/authenticated roles exist, enable RLS on created tables" bullet — same bar buildCreateStagingSql/buildCreateQuarantineSql already hold staging/quarantine tables to. */
export function buildEnableRlsSql(entity: { namespace: string; name: string }): string {
  return `ALTER TABLE ${quoteIdent(entity.namespace)}.${quoteIdent(entity.name)} ENABLE ROW LEVEL SECURITY`;
}
