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

const TABLES_SQL = `
  SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name,
         CASE WHEN TABLE_TYPE = 'VIEW' THEN 'view' ELSE 'table' END AS kind
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_TYPE IN ('BASE TABLE', 'VIEW')
  ORDER BY TABLE_SCHEMA, TABLE_NAME
`;

const COLUMNS_SQL = `
  SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name,
         COLUMN_NAME AS column_name, DATA_TYPE AS data_type,
         IS_NULLABLE AS is_nullable, ORDINAL_POSITION AS ordinal_position
  FROM INFORMATION_SCHEMA.COLUMNS
  ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
`;

/**
 * Builds the Planometry catalog from INFORMATION_SCHEMA — tables and
 * views, schema-qualified names (e.g. "dbo.vw_salesdata"), nullability,
 * and the 5-type mapping (nativeTypeMapping.ts), excluding unsupported
 * native types with a reason. `sourceTimeZone` is carried through
 * unchanged into the catalog; it isn't used for introspection itself.
 */
export async function introspectCatalog(pool: sql.ConnectionPool, sourceTimeZone: string): Promise<Catalog> {
  const [tablesResult, columnsResult] = await Promise.all([
    pool.request().query<TableRow>(TABLES_SQL),
    pool.request().query<ColumnRow>(COLUMNS_SQL),
  ]);

  const tables = new Map<string, CatalogTable>();
  for (const row of tablesResult.recordset) {
    const name = `${row.schema_name}.${row.table_name}`;
    tables.set(name, { name, kind: row.kind, columns: [], excluded: [] });
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
