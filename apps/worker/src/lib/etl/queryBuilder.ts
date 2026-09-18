import type { DialectQuery, QueryPayload, SourceDialect } from "@nia/schemas";

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
  keyColumn: string | undefined,
  cursor: string | number | null,
  limit: number,
): QueryPayload {
  if (dialect === "mongo") {
    const pipeline: Record<string, unknown>[] =
      dialectQuery && dialectQuery.dialect === "mongo" ? [...dialectQuery.pipeline] : [];
    if (cursor !== null) pipeline.push({ $match: { _id: { $gt: cursor } } });
    pipeline.push({ $sort: { _id: 1 } }, { $limit: limit });
    return { kind: "mongo", collection: entity.name, pipeline };
  }

  // SQL callers must have already verified keyColumn is a real, single-
  // column unique key (runEtl.ts's hard-fail precondition) — this function
  // doesn't re-verify that itself, it only builds the query shape.
  if (!keyColumn) {
    throw new Error("buildEtlReadQuery: SQL dialects require a keyColumn for keyset pagination.");
  }
  const sqlQuery = dialectQuery && dialectQuery.dialect !== "mongo" ? dialectQuery : null;
  const selectParts = ["*"];
  if (sqlQuery?.selectSql) selectParts.push(sqlQuery.selectSql);
  const from = `${quoteIdent(entity.namespace, dialect)}.${quoteIdent(entity.name, dialect)}`;
  const quotedKey = quoteIdent(keyColumn, dialect);
  const params = [...(sqlQuery?.params ?? [])];
  const conditions = sqlQuery?.whereSql ? [sqlQuery.whereSql] : [];
  if (cursor !== null) {
    // params are positional (?/$n resolved downstream per-dialect by the
    // connector, same convention as sqlQuery.params) — the cursor param is
    // appended last since it's added last to `conditions`.
    conditions.push(`${quotedKey} > ${dialect === "mysql" ? "?" : `$${params.length + 1}`}`);
    params.push(cursor);
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT ${selectParts.join(", ")} FROM ${from}${where} ORDER BY ${quotedKey} LIMIT ${limit}`;
  return { kind: "sql", sql, params };
}
