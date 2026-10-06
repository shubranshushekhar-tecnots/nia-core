import sql from "mssql";
import { validateExtractRequest } from "../filterBuilder.js";
import { serializeValue } from "../valueSerializer.js";
import type { Catalog, ExtractRequest, ExtractType } from "../types.js";
import { buildSelectSql } from "./buildSelectSql.js";
import { getColumnNativeTypes } from "./introspect.js";
import { SQL_LOCK_TIMEOUT_ERROR_NUMBER, TransientExtractError } from "./streamExtract.js";

export interface KeysetBatchOptions {
  /** Same meaning/default as StreamExtractOptions.lockTimeoutMs (streamExtract.ts). */
  lockTimeoutMs?: number;
}

export interface KeysetBatchResult {
  columns: { name: string; type: ExtractType }[];
  rows: (string | number | boolean | null)[][];
  /** Raw (unserialized) key column values for the next page's cursor, or null once `isLast` is true. */
  nextCursor: unknown[] | null;
  isLast: boolean;
}

/**
 * One-shot, non-streaming keyset-paged read of up to `limit` rows — the
 * agent-bridge read_batch task's counterpart to streamExtract.ts's
 * unbounded stream (Slice T2: a bridge task reads a bounded batch per
 * call, not an open-ended stream). Requires `table.primaryKey` (composite
 * or not — this package's keyset read is genuinely composite-aware, see
 * CatalogTable.primaryKey's own doc comment); throws if the table has
 * none, since there is no other stable way to seek a next page.
 *
 * Key columns are always selected (merged into the query even if the
 * caller didn't request them) so `nextCursor` can be read back from the
 * last row, but the returned `columns`/`rows` only ever contain the
 * caller's originally requested columns, in their original order — a key
 * column added solely for cursoring is never leaked into the output.
 *
 * Reuses streamExtract.ts's lock-timeout classification (same SQL Server
 * error 1222 -> TransientExtractError mapping) and its requestTimeout:0 /
 * same-batch SET LOCK_TIMEOUT override, for the same reason: a single
 * batch read can legitimately block on a lock for longer than tedious's
 * 15s time-to-first-byte default.
 */
export async function extractKeysetBatch(
  pool: sql.ConnectionPool,
  catalog: Catalog,
  request: ExtractRequest,
  cursor: unknown[] | null,
  limit: number,
  options: KeysetBatchOptions = {},
): Promise<KeysetBatchResult> {
  const { table, columns: requestedColumns } = validateExtractRequest(catalog, request);
  if (!table.primaryKey || table.primaryKey.length === 0) {
    throw new Error(`extractKeysetBatch: table ${JSON.stringify(table.name)} has no primary key — keyset reads require one`);
  }
  const keyColumns = table.primaryKey;
  const selectColumns = [...new Set([...requestedColumns, ...keyColumns])];

  const nativeTypes = await getColumnNativeTypes(pool, table.name);
  const { sql: selectSql, params } = buildSelectSql(table, nativeTypes, selectColumns, request.filter, limit, { keyColumns, cursor });

  // Same-batch SET (see streamExtract.ts's StreamExtractOptions.lockTimeoutMs doc comment) — a plain SELECT with no leading statement, so prepending this is safe.
  const lockTimeoutMs = options.lockTimeoutMs ?? 300_000;
  const sqlText = `SET LOCK_TIMEOUT ${lockTimeoutMs};\n${selectSql}`;

  // @types/mssql doesn't declare the `overrides` constructor arg (see streamExtract.ts's own comment on this same cast).
  type RequestWithOverrides = new (connection: sql.ConnectionPool, overrides?: { requestTimeout?: number }) => sql.Request;
  const sqlRequest = new (sql.Request as unknown as RequestWithOverrides)(pool, { requestTimeout: 0 });
  for (let i = 0; i < params.length; i++) {
    sqlRequest.input(`p${i + 1}`, params[i]);
  }

  let result: sql.IResult<Record<string, unknown>>;
  try {
    result = await sqlRequest.query<Record<string, unknown>>(sqlText);
  } catch (err) {
    const isLockTimeout = err instanceof Error && (err as Error & { number?: number }).number === SQL_LOCK_TIMEOUT_ERROR_NUMBER;
    throw isLockTimeout ? new TransientExtractError((err as Error).message) : err;
  }

  const rows = result.recordset;
  const selectColumnTypes = selectColumns.map((name) => {
    const col = table.columns.find((c) => c.name === name);
    if (!col) throw new Error(`extractKeysetBatch: resolved column ${JSON.stringify(name)} missing from catalog table ${JSON.stringify(table.name)}`);
    return col;
  });
  const outputColumnTypes = selectColumnTypes.filter((c) => requestedColumns.includes(c.name));

  const isLast = rows.length < limit;
  const nextCursor = isLast || rows.length === 0 ? null : keyColumns.map((col) => rows[rows.length - 1]![col]);

  return {
    columns: outputColumnTypes.map((c) => ({ name: c.name, type: c.type })),
    rows: rows.map((row) => outputColumnTypes.map((c) => serializeValue(c.type, row[c.name]))),
    nextCursor,
    isLast,
  };
}
