import { buildSelectSql, connect, getColumnNativeTypes, introspectCatalog } from "@nia/extract/mssql";
import { resolveTable, serializeValue, type CatalogColumn } from "@nia/extract";
import type { ConnectionEntry } from "../config/types.js";

export interface SqlCredentials {
  user: string;
  password: string;
}

export interface TableSummary {
  schema: string;
  table: string;
  kind: "table" | "view";
  /** Approximate row count from `sys.partitions`, or `null` for a view (views have no partition row counts). */
  rowCount: number | null;
}

/**
 * Row counts for every real table, read from `sys.partitions` (index_id
 * 0 = heap, 1 = clustered index — exactly one of the two exists per
 * table, so summing both is safe and gets the live count either way).
 * Available unchanged since SQL Server 2005, so this works on SQL
 * Server 2008 too, same vintage as introspect.ts's INFORMATION_SCHEMA
 * queries. Views are deliberately not joined in here -- they have no
 * storage/partitions of their own; `listTables` below reports `null`
 * for them rather than 0, which would misleadingly read as "empty".
 */
const ROW_COUNTS_SQL = `
  SELECT s.name AS schema_name, t.name AS table_name, SUM(p.rows) AS row_count
  FROM sys.tables t
  JOIN sys.schemas s ON t.schema_id = s.schema_id
  JOIN sys.partitions p ON t.object_id = p.object_id AND p.index_id IN (0, 1)
  GROUP BY s.name, t.name
`;

function splitQualifiedName(name: string): { schema: string; table: string } {
  const dot = name.indexOf(".");
  return dot === -1 ? { schema: "dbo", table: name } : { schema: name.slice(0, dot), table: name.slice(dot + 1) };
}

/** Same connection shape as `core/connections.ts`'s `testConnection` -- one pool per call, always closed in a `finally`. */
async function openPool(entry: ConnectionEntry, credentials: SqlCredentials) {
  return connect({
    server: entry.sqlserver.host,
    port: entry.sqlserver.port,
    instanceName: entry.sqlserver.instanceName,
    database: entry.sqlserver.database,
    user: credentials.user,
    password: credentials.password,
    encrypt: entry.sqlserver.encrypt,
    allowLegacyTls: entry.sqlserver.allowLegacyTls,
    trustServerCertificate: entry.sqlserver.trustServerCertificate,
  });
}

/** `GET /connections/:id/tables`: every table/view the catalog sees, with an approximate row count for real tables. Read-only. */
export async function listTables(entry: ConnectionEntry, credentials: SqlCredentials): Promise<TableSummary[]> {
  const pool = await openPool(entry, credentials);
  try {
    const [catalog, rowCountsResult] = await Promise.all([
      introspectCatalog(pool, entry.sourceTimeZone),
      pool.request().query<{ schema_name: string; table_name: string; row_count: number }>(ROW_COUNTS_SQL),
    ]);
    const rowCounts = new Map<string, number>();
    for (const row of rowCountsResult.recordset) rowCounts.set(`${row.schema_name}.${row.table_name}`, row.row_count);

    return catalog.tables.map((t) => {
      const { schema, table } = splitQualifiedName(t.name);
      return { schema, table, kind: t.kind, rowCount: t.kind === "view" ? null : rowCounts.get(t.name) ?? null };
    });
  } finally {
    await pool.close();
  }
}

/**
 * `GET /connections/:id/tables/:table/columns`: resolves `table` against
 * the real, freshly-introspected catalog (`resolveTable` throws
 * `UnknownTableError` for anything not an exact match) before returning
 * its columns -- this is what makes `table` safe to use at all; it's
 * never parsed as free text past this point.
 */
export async function listColumns(entry: ConnectionEntry, credentials: SqlCredentials, table: string): Promise<CatalogColumn[]> {
  const pool = await openPool(entry, credentials);
  try {
    const catalog = await introspectCatalog(pool, entry.sourceTimeZone);
    return resolveTable(catalog, table).columns;
  } finally {
    await pool.close();
  }
}

/** Hard cap on every preview, regardless of what a caller asks for -- see this module's doc comment and docs/agent-local-api.md. */
export const MAX_PREVIEW_ROWS = 50;

export interface TablePreview {
  columns: CatalogColumn[];
  rows: Record<string, string | number | boolean | null>[];
}

/**
 * `GET /connections/:id/tables/:table/preview?limit=`: read-only
 * `SELECT TOP <n> <quoted columns> FROM <quoted table>`, built by
 * `@nia/extract/mssql`'s `buildSelectSql` (same SQL-generation path the
 * real sync uses) against a catalog-resolved table/columns, so every
 * identifier in the query came from the server's own catalog, never
 * from caller-supplied text. `limit` is clamped to `MAX_PREVIEW_ROWS`
 * no matter what's requested -- never trust the caller's number alone.
 */
export async function previewTable(
  entry: ConnectionEntry,
  credentials: SqlCredentials,
  table: string,
  limit: number,
): Promise<TablePreview> {
  const clampedLimit = Math.max(1, Math.min(Math.trunc(limit) || MAX_PREVIEW_ROWS, MAX_PREVIEW_ROWS));
  const pool = await openPool(entry, credentials);
  try {
    const catalog = await introspectCatalog(pool, entry.sourceTimeZone);
    const resolved = resolveTable(catalog, table);
    if (resolved.columns.length === 0) return { columns: [], rows: [] };

    const nativeTypes = await getColumnNativeTypes(pool, resolved.name);
    const columnNames = resolved.columns.map((c) => c.name);
    const { sql } = buildSelectSql(resolved, nativeTypes, columnNames, [], clampedLimit);

    const result = await pool.request().query<Record<string, unknown>>(sql);
    const rows = result.recordset.map((row) => {
      const out: Record<string, string | number | boolean | null> = {};
      for (const col of resolved.columns) out[col.name] = serializeValue(col.type, row[col.name]);
      return out;
    });
    return { columns: resolved.columns, rows };
  } finally {
    await pool.close();
  }
}
