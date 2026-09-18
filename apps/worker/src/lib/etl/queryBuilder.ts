import type { DialectQuery, QueryPayload, SourceDialect } from "@nia/schemas";

/**
 * Phase 6 Block 3 — builds the real ETL runner's per-chunk read query.
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
 * `orderColumn` is a best-effort stability aid for offset pagination:
 * contract.ts's IntrospectResponse carries no primary-key marker, so there
 * is no dialect-agnostic way to know a real key column. SQL sources sort by
 * the first introspected field name (or omit ORDER BY entirely if the
 * entity has no fields) — good enough to make repeated chunks reasonably
 * stable in practice, not a correctness guarantee against concurrent writes
 * to the source during a run. Mongo sources always sort by `_id` instead
 * (guaranteed to exist and be stable), ignoring `orderColumn`.
 */

/** Guardrails cap every query's effective row count at 1000 regardless of what's requested (packages/guardrails/src/sql/validator.ts and mongodb.ts) — clamping here makes that explicit instead of silently truncated downstream. */
export const MAX_CHUNK_ROWS = 1000;

function quoteIdent(name: string, dialect: "mysql" | "postgres"): string {
  if (dialect === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

export function buildEtlReadQuery(
  dialect: SourceDialect,
  entity: { namespace: string; name: string },
  dialectQuery: DialectQuery | null,
  orderColumn: string | undefined,
  offset: number,
  limit: number,
): QueryPayload {
  if (dialect === "mongo") {
    const pipeline: Record<string, unknown>[] =
      dialectQuery && dialectQuery.dialect === "mongo" ? [...dialectQuery.pipeline] : [];
    pipeline.push({ $sort: { _id: 1 } }, { $skip: offset }, { $limit: limit });
    return { kind: "mongo", collection: entity.name, pipeline };
  }

  const sqlQuery = dialectQuery && dialectQuery.dialect !== "mongo" ? dialectQuery : null;
  const selectParts = ["*"];
  if (sqlQuery?.selectSql) selectParts.push(sqlQuery.selectSql);
  const from = `${quoteIdent(entity.namespace, dialect)}.${quoteIdent(entity.name, dialect)}`;
  const where = sqlQuery?.whereSql ? ` WHERE ${sqlQuery.whereSql}` : "";
  const orderBy = orderColumn ? ` ORDER BY ${quoteIdent(orderColumn, dialect)}` : "";
  const sql = `SELECT ${selectParts.join(", ")} FROM ${from}${where}${orderBy} LIMIT ${limit} OFFSET ${offset}`;
  return { kind: "sql", sql, params: sqlQuery?.params ?? [] };
}
