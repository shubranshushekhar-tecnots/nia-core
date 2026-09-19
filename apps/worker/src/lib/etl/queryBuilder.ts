import { mysqlAdapter, postgresAdapter, type DialectQuery, type QueryPayload, type SourceDialect, type SqlDialectAdapter } from "@nia/schemas";

/**
 * Phase 6 Block 3 (offset pagination) / Block 3.5 (keyset pagination) —
 * builds the real ETL runner's per-chunk read query.
 *
 * Deliberately NOT the same shape as apps/worker/src/lib/preview/
 * runPreview.ts's buildPreviewQuery: that helper aliases `from AS to`
 * straight in SQL/Mongo and never executes residual transforms (fine for a
 * one-shot 50-row preview). The real runner needs to actually run every
 * residual transform step correctly, so this fetches RAW, source-named
 * columns (`SELECT *` / no `$project`) plus only the pushed-down computed
 * columns — the in-process residualTransform.ts step and the final
 * from->to mapping projection both happen afterward, in runEtl.ts.
 *
 * Block 3.5: replaced LIMIT/OFFSET (safe only under an assumption that a
 * non-unique sort column has no ties, which isn't guaranteed) with keyset
 * pagination — `WHERE key > cursor ORDER BY key LIMIT n` — immune to ties
 * and to offset drift from concurrent writes during the run. `keyColumn`
 * for SQL sources is IntrospectResponse's verified single-column primary
 * key (contract.ts); runEtl.ts hard-fails before ever calling this if the
 * source entity has none. Mongo sources always key off `_id` (guaranteed
 * unique), ignoring `keyColumn`, same as before.
 *
 * Block 6: a pushed `aggregate` transform step (`dialectQuery.isAggregate`)
 * is NEVER keyset-paginated — GROUP BY/$group collapses row identity, which
 * eliminates the very column pagination cursors on. Such a query instead
 * runs as a single flat, non-paginated statement capped by `limit`
 * (MAX_CHUNK_ROWS output GROUPS, not source rows) — runEtl.ts forces
 * `isLastChunk: true` for this case. Real, disclosed v1 limitation (see
 * TODO.md): an aggregate producing more than MAX_CHUNK_ROWS groups is
 * silently truncated, not paginated across multiple runner chunks.
 */

/** Guardrails cap every query's effective row count at 1000 regardless of what's requested (packages/guardrails/src/sql/validator.ts and mongodb.ts) — clamping here makes that explicit instead of silently truncated downstream. */
export const MAX_CHUNK_ROWS = 1000;

function sqlAdapterFor(dialect: "mysql" | "postgres"): SqlDialectAdapter {
  return dialect === "mysql" ? mysqlAdapter : postgresAdapter;
}

export function buildEtlReadQuery(
  dialect: SourceDialect,
  entity: { namespace: string; name: string },
  dialectQuery: DialectQuery | null,
  keyColumn: string | undefined,
  cursor: string | number | null,
  limit: number,
): QueryPayload {
  if (dialect === "mongo") {
    const mongoQuery = dialectQuery && dialectQuery.dialect === "mongo" ? dialectQuery : null;
    const pipeline: Record<string, unknown>[] = mongoQuery ? [...mongoQuery.pipeline] : [];
    if (mongoQuery?.isAggregate) {
      // No keyset stages — $group has already collapsed row identity. Single non-paginated run, capped by limit (see this file's header comment).
      pipeline.push({ $limit: limit });
      return { kind: "mongo", collection: entity.name, pipeline };
    }
    if (cursor !== null) pipeline.push({ $match: { _id: { $gt: cursor } } });
    pipeline.push({ $sort: { _id: 1 } }, { $limit: limit });
    return { kind: "mongo", collection: entity.name, pipeline };
  }

  const adapter = sqlAdapterFor(dialect);
  const sqlQuery = dialectQuery && dialectQuery.dialect !== "mongo" ? dialectQuery : null;
  const from = `${adapter.quoteIdent(entity.namespace)}.${adapter.quoteIdent(entity.name)}`;

  if (sqlQuery?.isAggregate) {
    // No keyset pagination — GROUP BY has already collapsed the source primary key. Single non-paginated run, capped by limit (see this file's header comment).
    const params = [...sqlQuery.params];
    const where = sqlQuery.whereSql ? ` WHERE ${sqlQuery.whereSql}` : "";
    const groupBy = sqlQuery.groupBySql ? ` GROUP BY ${sqlQuery.groupBySql}` : "";
    const having = sqlQuery.havingSql ? ` HAVING ${sqlQuery.havingSql}` : "";
    const sql = `SELECT ${sqlQuery.selectSql} FROM ${from}${where}${groupBy}${having} LIMIT ${limit}`;
    return { kind: "sql", sql, params };
  }

  // SQL callers must have already verified keyColumn is a real, single-
  // column unique key (runEtl.ts's hard-fail precondition) — this function
  // doesn't re-verify that itself, it only builds the query shape.
  if (!keyColumn) {
    throw new Error("buildEtlReadQuery: SQL dialects require a keyColumn for keyset pagination.");
  }
  const selectParts = ["*"];
  if (sqlQuery?.selectSql) selectParts.push(sqlQuery.selectSql);
  const quotedKey = adapter.quoteIdent(keyColumn);
  const params = [...(sqlQuery?.params ?? [])];
  const conditions = sqlQuery?.whereSql ? [sqlQuery.whereSql] : [];
  if (cursor !== null) {
    // params are positional (?/$n resolved downstream per-dialect by the
    // connector, same convention as sqlQuery.params) — the cursor param is
    // appended last since it's added last to `conditions`.
    conditions.push(`${quotedKey} > ${adapter.placeholder(params.length + 1)}`);
    params.push(cursor);
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT ${selectParts.join(", ")} FROM ${from}${where} ORDER BY ${quotedKey} LIMIT ${limit}`;
  return { kind: "sql", sql, params };
}
