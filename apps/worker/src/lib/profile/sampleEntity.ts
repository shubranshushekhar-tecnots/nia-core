import { mysqlAdapter, postgresAdapter, type QueryPayload, type SourceDialect, type SqlDialectAdapter, type SampleMethod } from "@nia/schemas";
import { dispatch } from "../dispatch.js";
import type { WorkspaceScope } from "@nia/db";
import type { DispatchResult } from "../errors.js";
import type { TabularResult } from "@nia/schemas";

/**
 * Phase 10 Step 3A — keyset head/tail sampling, one connector round trip
 * per 1000-row page (packages/guardrails/src/sql/validator.ts's
 * `maxRows: 1000` clamps any single query regardless of what's requested —
 * see apps/worker/src/lib/etl/queryBuilder.ts's MAX_CHUNK_ROWS comment),
 * so a 5,000-row head/tail sample is up to 5 pages per direction, 10 total.
 *
 * Mirrors queryBuilder.ts's buildEtlReadQuery keyset-pagination query shape
 * (same `WHERE key > cursor ORDER BY key LIMIT n` / mongo `$match`+`$sort`+
 * `$limit` pattern) rather than importing it directly: that function is
 * wired for the ETL runner's DialectQuery/ParamSink-compiled cursor
 * plumbing, which this profiler has no use for — profiling only ever reads
 * raw source columns with a plain scalar cursor, never a pushed-down
 * transform.
 */

const PAGE_SIZE = 1000;
const MAX_PAGES_PER_DIRECTION = 5;

export type SampleResult = {
  sampleMethod: SampleMethod;
  rows: Record<string, unknown>[];
  columns: string[];
};

function sqlAdapterFor(dialect: "mysql" | "postgres"): SqlDialectAdapter {
  return dialect === "mysql" ? mysqlAdapter : postgresAdapter;
}

function buildSqlPage(
  dialect: "mysql" | "postgres",
  entity: { namespace: string; name: string },
  keyColumn: string,
  direction: "asc" | "desc",
  cursor: string | number | null,
): QueryPayload {
  const adapter = sqlAdapterFor(dialect);
  const from = `${adapter.quoteIdent(entity.namespace)}.${adapter.quoteIdent(entity.name)}`;
  const quotedKey = adapter.quoteIdent(keyColumn);
  const order = direction === "asc" ? "ASC" : "DESC";
  const params: unknown[] = [];
  let where = "";
  if (cursor !== null) {
    const op = direction === "asc" ? ">" : "<";
    where = ` WHERE ${quotedKey} ${op} ${adapter.placeholder(1)}`;
    params.push(cursor);
  }
  const sql = `SELECT * FROM ${from}${where} ORDER BY ${quotedKey} ${order} LIMIT ${PAGE_SIZE}`;
  return { kind: "sql", sql, params };
}

function buildMongoPage(entity: { name: string }, direction: "asc" | "desc", cursor: string | null): QueryPayload {
  const pipeline: Record<string, unknown>[] = [];
  if (cursor !== null) {
    const op = direction === "asc" ? "$gt" : "$lt";
    pipeline.push({ $match: { _id: { [op]: cursor } } });
  }
  pipeline.push({ $sort: { _id: direction === "asc" ? 1 : -1 } }, { $limit: PAGE_SIZE });
  return { kind: "mongo", collection: entity.name, pipeline };
}

function buildPage(
  dialect: SourceDialect,
  entity: { namespace: string; name: string },
  keyColumn: string,
  direction: "asc" | "desc",
  cursor: string | number | null,
): QueryPayload {
  if (dialect === "mongo") return buildMongoPage(entity, direction, cursor as string | null);
  return buildSqlPage(dialect, entity, keyColumn, direction, cursor);
}

function toRecords(result: TabularResult): Record<string, unknown>[] {
  const names = result.columns.map((c) => c.name);
  return result.rows.map((row) => Object.fromEntries(names.map((n, i) => [n, row[i]])));
}

/**
 * Fetches up to MAX_PAGES_PER_DIRECTION pages (keyset-paginated by
 * `keyColumn`, ascending) starting from `cursor`. Stops early — reporting
 * the table as exhausted — the moment a page comes back shorter than
 * PAGE_SIZE, since that can only happen on the last page.
 */
async function fetchDirection(
  dialect: SourceDialect,
  entity: { namespace: string; name: string },
  keyColumn: string,
  direction: "asc" | "desc",
  connectionId: string,
  scope: WorkspaceScope,
  actorUserId: string,
): Promise<DispatchResult<{ rows: Record<string, unknown>[]; columns: string[]; exhausted: boolean }>> {
  const rows: Record<string, unknown>[] = [];
  let columns: string[] = [];
  let cursor: string | number | null = null;
  let exhausted = false;

  for (let page = 0; page < MAX_PAGES_PER_DIRECTION; page++) {
    const query = buildPage(dialect, entity, keyColumn, direction, cursor);
    const result = await dispatch(connectionId, query, scope, actorUserId, { rowCap: PAGE_SIZE });
    if (!result.ok) return result;

    columns = result.value.columns.map((c) => c.name);
    const pageRows = toRecords(result.value);
    rows.push(...pageRows);

    if (pageRows.length < PAGE_SIZE) {
      exhausted = true;
      break;
    }
    const last = pageRows[pageRows.length - 1]!;
    cursor = last[keyColumn] as string | number;
  }

  return { ok: true, value: { rows, columns, exhausted } };
}

/**
 * Whole-table sampling for dialects/entities with no usable single-column
 * key — reported as `sampleMethod: "no-key-scan"` (a deliberate,
 * documented limitation: one unordered page of up to PAGE_SIZE rows, no
 * head/tail distinction possible without a stable sort key).
 */
async function fetchUnkeyedPage(
  dialect: SourceDialect,
  entity: { namespace: string; name: string },
  connectionId: string,
  scope: WorkspaceScope,
  actorUserId: string,
): Promise<DispatchResult<SampleResult>> {
  const query: QueryPayload =
    dialect === "mongo"
      ? { kind: "mongo", collection: entity.name, pipeline: [{ $limit: PAGE_SIZE }] }
      : (() => {
          const adapter = sqlAdapterFor(dialect as "mysql" | "postgres");
          const from = `${adapter.quoteIdent(entity.namespace)}.${adapter.quoteIdent(entity.name)}`;
          return { kind: "sql", sql: `SELECT * FROM ${from} LIMIT ${PAGE_SIZE}`, params: [] };
        })();

  const result = await dispatch(connectionId, query, scope, actorUserId, { rowCap: PAGE_SIZE });
  if (!result.ok) return result;
  return {
    ok: true,
    value: { sampleMethod: "no-key-scan", rows: toRecords(result.value), columns: result.value.columns.map((c) => c.name) },
  };
}

/**
 * Entry point: samples up to 5,000 rows from the head and 5,000 from the
 * tail (by `keyColumn`, both directions), deduped by key on merge. If the
 * head fetch alone exhausts the table (a page shorter than PAGE_SIZE
 * before 5 pages), the table is smaller than the sample budget and the
 * tail fetch is skipped entirely — reported as `sampleMethod: "full-table"`
 * rather than `"keyset-head-tail"`.
 *
 * `keyColumn` is `null` for mongo (which always keys off `_id` — same
 * convention as queryBuilder.ts's buildEtlReadQuery) or for a SQL entity
 * with no single-column primary key, in which case this falls back to
 * fetchUnkeyedPage.
 */
export async function sampleEntity(
  dialect: SourceDialect,
  entity: { namespace: string; name: string },
  keyColumn: string | null,
  connectionId: string,
  scope: WorkspaceScope,
  actorUserId: string,
): Promise<DispatchResult<SampleResult>> {
  const effectiveKey = dialect === "mongo" ? "_id" : keyColumn;
  if (!effectiveKey) {
    return fetchUnkeyedPage(dialect, entity, connectionId, scope, actorUserId);
  }

  const head = await fetchDirection(dialect, entity, effectiveKey, "asc", connectionId, scope, actorUserId);
  if (!head.ok) return head;

  if (head.value.exhausted) {
    return { ok: true, value: { sampleMethod: "full-table", rows: head.value.rows, columns: head.value.columns } };
  }

  const tail = await fetchDirection(dialect, entity, effectiveKey, "desc", connectionId, scope, actorUserId);
  if (!tail.ok) return tail;

  const seen = new Set<unknown>();
  const merged: Record<string, unknown>[] = [];
  for (const row of head.value.rows) {
    seen.add(row[effectiveKey]);
    merged.push(row);
  }
  // tail.rows are in descending key order; reverse so the merged sample as
  // a whole stays ascending (head ... gap ... tail), though row ORDER
  // within the sample has no semantic meaning downstream (stats.ts treats
  // it as an unordered bag of values per column).
  for (const row of [...tail.value.rows].reverse()) {
    if (seen.has(row[effectiveKey])) continue;
    seen.add(row[effectiveKey]);
    merged.push(row);
  }

  const columns = head.value.columns.length > 0 ? head.value.columns : tail.value.columns;
  return { ok: true, value: { sampleMethod: "keyset-head-tail", rows: merged, columns } };
}
