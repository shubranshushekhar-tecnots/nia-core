import type sql from "mssql";
import type { Catalog, CatalogColumn, CatalogTable, ExcludedColumn } from "../types.js";
import { nativeTypeInfo } from "./nativeTypeMapping.js";

interface TableRow {
  schema_name: string;
  table_name: string;
  kind: "table" | "view";
}

interface ColumnRow {
  schema_name: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
  ordinal_position: number;
}

interface PrimaryKeyRow {
  schema_name: string;
  table_name: string;
  column_name: string;
  key_ordinal: number;
}

// INFORMATION_SCHEMA.TABLES/COLUMNS are available unchanged since SQL
// Server 2000 — no sys.* catalog views, no version-gated columns — so
// these two queries already work as-is on SQL Server 2008 (GMS's
// version). Exported (not just module-private) so sql2008DenyList.test.ts
// can scan them for 2012+ features without a live connection.
export const TABLES_SQL = `
  SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name,
         CASE WHEN TABLE_TYPE = 'VIEW' THEN 'view' ELSE 'table' END AS kind
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_TYPE IN ('BASE TABLE', 'VIEW')
  ORDER BY TABLE_SCHEMA, TABLE_NAME
`;

export const COLUMNS_SQL = `
  SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name,
         COLUMN_NAME AS column_name, DATA_TYPE AS data_type,
         IS_NULLABLE AS is_nullable, ORDINAL_POSITION AS ordinal_position
  FROM INFORMATION_SCHEMA.COLUMNS
  ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
`;

// Slice T2 — INFORMATION_SCHEMA.TABLE_CONSTRAINTS/KEY_COLUMN_USAGE are the
// same vintage as TABLES_SQL/COLUMNS_SQL above (available unchanged since
// SQL Server 2000, no sys.* catalog views) — joined on CONSTRAINT_NAME +
// schema to find every PRIMARY KEY constraint's column(s), in their real
// key-ordinal order (KEY_COLUMN_USAGE.ORDINAL_POSITION is the position
// *within the key*, not the table — exactly what a composite key's
// column order for keyset paging needs). One row per key column; a
// single-column PK yields one row, a composite PK yields one row per
// column, grouped back into an array below.
export const PRIMARY_KEYS_SQL = `
  SELECT kcu.TABLE_SCHEMA AS schema_name, kcu.TABLE_NAME AS table_name,
         kcu.COLUMN_NAME AS column_name, kcu.ORDINAL_POSITION AS key_ordinal
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
  JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
    ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
   AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
   AND tc.TABLE_NAME = kcu.TABLE_NAME
  WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
  ORDER BY kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.ORDINAL_POSITION
`;

/**
 * Builds the Planometry catalog from INFORMATION_SCHEMA — tables and
 * views, schema-qualified names (e.g. "dbo.vw_salesdata"), nullability,
 * and the 5-type mapping (nativeTypeMapping.ts), excluding unsupported
 * native types with a reason. `sourceTimeZone` is carried through
 * unchanged into the catalog; it isn't used for introspection itself.
 */
export async function introspectCatalog(pool: sql.ConnectionPool, sourceTimeZone: string): Promise<Catalog> {
  const [tablesResult, columnsResult, primaryKeysResult] = await Promise.all([
    pool.request().query<TableRow>(TABLES_SQL),
    pool.request().query<ColumnRow>(COLUMNS_SQL),
    pool.request().query<PrimaryKeyRow>(PRIMARY_KEYS_SQL),
  ]);

  const tables = new Map<string, CatalogTable>();
  for (const row of tablesResult.recordset) {
    const name = `${row.schema_name}.${row.table_name}`;
    tables.set(name, { name, kind: row.kind, columns: [], excluded: [], primaryKey: null });
  }

  for (const row of columnsResult.recordset) {
    const name = `${row.schema_name}.${row.table_name}`;
    const table = tables.get(name);
    if (!table) continue; // column of a table/view kind we don't enumerate (shouldn't happen given the shared INFORMATION_SCHEMA filter, but don't crash introspection over it)

    const info = nativeTypeInfo(row.data_type);
    if (info.extractType === null) {
      const excluded: ExcludedColumn = { name: row.column_name, nativeType: row.data_type, reason: info.reason ?? `${row.data_type} is not supported` };
      table.excluded.push(excluded);
      continue;
    }
    const column: CatalogColumn = { name: row.column_name, type: info.extractType, nullable: row.is_nullable === "YES" };
    table.columns.push(column);
  }

  // Grouped by table, key_ordinal ascending (already guaranteed by
  // PRIMARY_KEYS_SQL's ORDER BY) — a single-column PK produces a
  // 1-element array, a composite PK a 2+ element array in real key
  // order. This package's own keyset read (buildSelectSql.ts/
  // extractKeysetBatch.ts) is composite-aware and pages by this array
  // directly; collapsing a composite key down to the wire-level
  // single-string convention (@nia/schemas's IntrospectResponse.entity.
  // primaryKey) is the caller's job, not this package's — see
  // CatalogTable.primaryKey's own doc comment.
  const primaryKeyColumns = new Map<string, string[]>();
  for (const row of primaryKeysResult.recordset) {
    const name = `${row.schema_name}.${row.table_name}`;
    if (!tables.has(name)) continue;
    const columns = primaryKeyColumns.get(name) ?? [];
    columns.push(row.column_name);
    primaryKeyColumns.set(name, columns);
  }
  for (const [name, columns] of primaryKeyColumns) {
    tables.get(name)!.primaryKey = columns;
  }

  return {
    generatedAt: new Date().toISOString(),
    sourceTimeZone,
    tables: [...tables.values()],
  };
}

/**
 * Fetches live native types for every column of one schema-qualified
 * table (e.g. "dbo.orders"), for buildSelectSql.ts's CAST-to-text
 * decision. Always queried fresh at extract time rather than trusting a
 * possibly-stale cached Catalog — defense in depth, not an optimization.
 * `table` must already be catalog-resolved (catalog.ts's resolveTable)
 * before this is called, so it's never attacker-controlled free text.
 */
export async function getColumnNativeTypes(pool: sql.ConnectionPool, table: string): Promise<Map<string, string>> {
  const dot = table.indexOf(".");
  const schema = dot === -1 ? "dbo" : table.slice(0, dot);
  const name = dot === -1 ? table : table.slice(dot + 1);
  const result = await pool
    .request()
    .input("schema", schema)
    .input("name", name)
    .query<{ column_name: string; data_type: string }>(
      `SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @name`,
    );
  const map = new Map<string, string>();
  for (const row of result.recordset) map.set(row.column_name, row.data_type);
  return map;
}
