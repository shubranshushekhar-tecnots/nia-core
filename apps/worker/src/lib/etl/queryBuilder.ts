import { mysqlAdapter, postgresAdapter, type DialectQuery, type FailurePreCheck, type QueryPayload, type SourceDialect, type SqlDialectAdapter } from "@nia/schemas";

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
 * Phase 9 Part 2: for SQL, the cursor condition is no longer appended
 * here — runEtl.ts now passes `dialectQuery` already compiled WITH the
 * cursor folded in (packages/schemas/src/pushdown.ts's `compileSql`
 * accepts a `SqlKeysetCursor` and resolves it through the same ParamSink
 * pass as every other literal, in real physical text order — see
 * ops/paramSink.ts's doc comment). This function's `cursor` param is now
 * consulted only for Mongo's `$match` stage, which has no ParamSink
 * concept to route through (literals embed directly into the BSON
 * pipeline).
 *
 * Phase 9 Part 3: a pushed `aggregate` transform step
 * (`dialectQuery.isAggregate`) is now paginated by GROUP-BY-column keyset
 * (not row keyset — GROUP BY/$group has already collapsed row identity, so
 * there is no source primary key left to page by). runEtl.ts recompiles
 * `dialectQuery` per chunk with a `SqlGroupKeyCursor`/Mongo `$match` folded
 * in the same way it does for the row-keyset cursor (see the Part 2 note
 * above) — by the time it reaches this function, `sqlQuery.whereSql` /
 * `mongoQuery.pipeline`'s leading `$match` already carries the group-key
 * predicate. This function's own job for the aggregate branch is just to
 * append `ORDER BY sqlQuery.orderBySql` (SQL) — Mongo's `$sort` stage is
 * already embedded in the compiled pipeline by compileMongo — before the
 * `LIMIT`/`$limit` cap.
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
      // Group-key $match (if any) and the trailing $sort are already embedded in mongoQuery.pipeline by compileMongo (see this file's header comment) — just cap it.
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
    // Group-key WHERE fragment (if any) is already folded into sqlQuery.whereSql by compileSql (see this file's header comment) — page by orderBySql, same as row keyset pages by keyColumn below.
    const params = [...sqlQuery.params];
    const where = sqlQuery.whereSql ? ` WHERE ${sqlQuery.whereSql}` : "";
    const groupBy = sqlQuery.groupBySql ? ` GROUP BY ${sqlQuery.groupBySql}` : "";
    const having = sqlQuery.havingSql ? ` HAVING ${sqlQuery.havingSql}` : "";
    const orderBy = sqlQuery.orderBySql ? ` ORDER BY ${sqlQuery.orderBySql}` : "";
    const sql = `SELECT ${sqlQuery.selectSql} FROM ${from}${where}${groupBy}${having}${orderBy} LIMIT ${limit}`;
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
  // The cursor condition (when present) is already folded into
  // sqlQuery.whereSql/params by compileSql's ParamSink pass (see this
  // file's header comment) — the caller (runEtl.ts) recompiles
  // dialectQuery with the current cursor before calling this function, so
  // there is nothing left to append here.
  const params = [...(sqlQuery?.params ?? [])];
  const where = sqlQuery?.whereSql ? ` WHERE ${sqlQuery.whereSql}` : "";
  const sql = `SELECT ${selectParts.join(", ")} FROM ${from}${where} ORDER BY ${quotedKey} LIMIT ${limit}`;
  return { kind: "sql", sql, params };
}

/**
 * Phase 9 Part 4 — wraps one `FailurePreCheck.dialectQuery` fragment
 * (compiled by `@nia/schemas`'s `compileFailurePreChecks`, reusing this
 * file's `buildEtlReadQuery` sibling's own dialect-branch pattern) into a
 * runnable `COUNT(*)` statement, dispatched once before extraction begins
 * (runEtl.ts). Uses `COUNT(*)` uniformly for every policy, including
 * "fail" — the plan's literal wording asks for `EXISTS` there, but
 * `COUNT(*) > 0` is exactly equivalent for the abort decision, and "fail"
 * needs an exact count anyway (its abort message names the failing-row
 * count, same as the residual path's `OnFailureAbortError`) — a single
 * query shape covers every policy with no branch on it.
 *
 * The fragment is either:
 *   - a plain filter fragment (`whereSql`/`$match` stages only) for a
 *     filter/computed_field pre-check — counts failing ROWS; or
 *   - an aggregate fragment (`isAggregate`, `having` replaced by the
 *     failure predicate) for an aggregate `having` pre-check — counts
 *     failing GROUPS, via a `SELECT 1 ... GROUP BY ... HAVING ...`
 *     subquery (COUNT(*) can't apply directly on top of GROUP BY/HAVING —
 *     it would count rows within the last group, not the number of
 *     groups).
 */
export function buildFailurePreCheckQuery(
  dialect: SourceDialect,
  entity: { namespace: string; name: string },
  dialectQuery: FailurePreCheck["dialectQuery"],
): QueryPayload {
  if (dialect === "mongo") {
    const mongoQuery = dialectQuery.dialect === "mongo" ? dialectQuery : null;
    const pipeline: Record<string, unknown>[] = mongoQuery ? [...mongoQuery.pipeline] : [];
    pipeline.push({ $count: "n" });
    return { kind: "mongo", collection: entity.name, pipeline };
  }

  const adapter = sqlAdapterFor(dialect);
  const sqlQuery = dialectQuery.dialect !== "mongo" ? dialectQuery : null;
  const from = `${adapter.quoteIdent(entity.namespace)}.${adapter.quoteIdent(entity.name)}`;
  const params = [...(sqlQuery?.params ?? [])];
  const where = sqlQuery?.whereSql ? ` WHERE ${sqlQuery.whereSql}` : "";

  if (sqlQuery?.isAggregate) {
    const groupBy = sqlQuery.groupBySql ? ` GROUP BY ${sqlQuery.groupBySql}` : "";
    const having = sqlQuery.havingSql ? ` HAVING ${sqlQuery.havingSql}` : "";
    const sql = `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${from}${where}${groupBy}${having}) AS failing_groups`;
    return { kind: "sql", sql, params };
  }

  const sql = `SELECT COUNT(*) AS n FROM ${from}${where}`;
  return { kind: "sql", sql, params };
}
