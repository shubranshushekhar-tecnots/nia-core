import { compileWhereClause, type WhereClauseAdapter } from "../filterBuilder.js";
import { assertSafeIdentifierText, createParamSink, resolveParamSink } from "../paramSink.js";
import type { CatalogTable, FilterCondition } from "../types.js";
import { nativeTypeInfo } from "./nativeTypeMapping.js";
import { quoteIdent, quoteQualifiedName } from "./quoteIdent.js";

const adapter: WhereClauseAdapter = { quoteIdent, likeEscapeChar: "\\" };

/**
 * `CONVERT(..., 121)` (ODBC canonical: "yyyy-mm-dd hh:mi:ss.mmm", space
 * separator, never a trailing Z/offset) for every naive datetime-family
 * column. This module deliberately casts `datetime`/`smalldatetime` to
 * text too, not just `datetime2`/`datetimeoffset` (the literal list in
 * docs/plans/planometry-integration.md) — see connection.ts's comment:
 * the mssql driver's native JS-Date conversion for naive datetime values
 * depends on the connection's `useUTC` setting (UTC or the Node
 * process's local zone), neither of which is `sourceTimeZone` in
 * general, so letting the driver produce a Date object would silently
 * mis-convert whenever the two differ. Casting to text and parsing by
 * hand (valueSerializer.ts) is the only way to honor the contract's "no-
 * zone values converted using sourceTimeZone" clause correctly for every
 * naive datetime-family type, not just datetime2/datetimeoffset.
 */
function selectExpr(columnName: string, nativeType: string): string {
  const quoted = quoteIdent(columnName);
  const info = nativeTypeInfo(nativeType);
  if (!info.castToText) return quoted;
  const t = nativeType.toLowerCase();
  if (t === "datetime" || t === "smalldatetime" || t === "datetime2") {
    return `CONVERT(VARCHAR(MAX), ${quoted}, 121)`;
  }
  if (t === "datetimeoffset") {
    // CAST's default text form keeps the real UTC offset verbatim (e.g. "2024-03-01 10:30:00.1234567 +02:00"), which valueSerializer.ts parses explicitly.
    return `CAST(${quoted} AS VARCHAR(MAX))`;
  }
  if (t === "money" || t === "smallmoney") {
    // Plain CAST(money AS VARCHAR(MAX)) silently rounds to 2 decimal
    // places (SQL Server's implicit money->varchar conversion defaults to
    // style 0) even though money's real precision is 4 decimal digits —
    // e.g. 0.0001 would come back as "0.00", losing data. CONVERT's
    // explicit style 2 keeps all 4 digits, no thousands separator.
    return `CONVERT(VARCHAR(MAX), ${quoted}, 2)`;
  }
  // decimal/numeric/bigint/time: default text conversion preserves exact digits.
  return `CAST(${quoted} AS VARCHAR(MAX))`;
}

export interface BuiltSelect {
  sql: string;
  params: unknown[];
}

/**
 * Builds one parameterized SELECT for a validated extract request.
 * `nativeTypes` maps every column name in `columns`/`filter` to its live
 * `INFORMATION_SCHEMA.COLUMNS.DATA_TYPE` (fetched fresh by the caller,
 * not trusted from a possibly-stale cached catalog — see introspect.ts).
 */
export function buildSelectSql(
  table: CatalogTable,
  nativeTypes: ReadonlyMap<string, string>,
  columns: string[],
  filter: FilterCondition[],
  limit?: number,
): BuiltSelect {
  const sink = createParamSink();

  const selectList = columns
    .map((name) => {
      const nativeType = nativeTypes.get(name);
      if (!nativeType) throw new Error(`buildSelectSql: no native type known for column ${JSON.stringify(name)}`);
      assertSafeIdentifierText(name);
      const expr = selectExpr(name, nativeType);
      return expr === quoteIdent(name) ? expr : `${expr} AS ${quoteIdent(name)}`;
    })
    .join(", ");

  const whereFragments = compileWhereClause(filter, adapter, sink);
  const whereSql = whereFragments.length > 0 ? ` WHERE ${whereFragments.join(" AND ")}` : "";
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error(`buildSelectSql: limit must be a positive integer, got ${limit}`);
  }
  const topSql = limit !== undefined ? `TOP (${limit}) ` : "";

  const rawSql = `SELECT ${topSql}${selectList} FROM ${quoteQualifiedName(table.name)}${whereSql}`;
  const { sql, params } = resolveParamSink(sink, rawSql, (i) => `@p${i}`);
  return { sql, params };
}
