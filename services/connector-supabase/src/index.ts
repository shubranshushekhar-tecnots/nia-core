import Fastify from "fastify";
import {
  TestRequest,
  IntrospectRequest,
  ExecuteRequest,
  InvalidateRequest,
  WriteRequest,
  type TabularResult,
  type WriteResponse,
} from "@nia/schemas";
import { getPool, getWritePool, evict, poolCount, verifyActiveWriteGrant } from "./pool-manager.js";
import { mapPostgresColumnType } from "./column-types.js";
import { executeWithStatementTimeout } from "./query.js";
import { verifyWriteContext } from "./writeSignature.js";
import { buildUpsertSql } from "./writeSql.js";

/**
 * connector-supabase — direct Postgres access (targets a Supabase project's
 * underlying Postgres, not its REST/PostgREST API). Same uniform contract as
 * connector-mysql/connector-mongodb: /test /introspect /execute /invalidate
 * /health, plus /write (Phase 6 Block 2 — this connector's etl_sink
 * capability; the first connector to get the write path, per the kickoff
 * spec).
 *
 * The worker sends dialect-native, guardrail-approved (postgres dialect)
 * queries. This service's jobs are pooling, execution, and normalization to
 * the tabular shape.
 */

const app = Fastify({ logger: true });

app.get("/health", async () => ({
  status: "ok" as const,
  service: "connector-supabase",
  pools: poolCount(),
  routes: ["test", "introspect", "execute", "invalidate", "write"],
}));

app.post("/test", async (req) => {
  const { credential, config } = TestRequest.parse(req.body);
  const start = Date.now();
  try {
    const pool = await getPool(credential, config);
    await pool.query("SELECT 1");
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "unknown" };
  }
});

app.post("/introspect", async (req) => {
  const { credential, config } = IntrospectRequest.parse(req.body);
  const pool = await getPool(credential, config);
  const result = await pool.query(
    `SELECT table_schema, table_name, column_name, data_type
     FROM information_schema.columns
     WHERE table_schema NOT IN ('information_schema','pg_catalog','pg_toast')
     ORDER BY table_schema, table_name, ordinal_position`,
  );
  const byEntity = new Map<string, { namespace: string; name: string; fields: { name: string; type: string }[] }>();
  for (const r of result.rows as Array<Record<string, string>>) {
    const key = `${r.table_schema}.${r.table_name}`;
    if (!byEntity.has(key)) {
      byEntity.set(key, { namespace: r.table_schema!, name: r.table_name!, fields: [] });
    }
    byEntity.get(key)!.fields.push({ name: r.column_name!, type: r.data_type! });
  }
  return { entities: [...byEntity.values()] };
});

app.post("/execute", async (req): Promise<TabularResult> => {
  const body = ExecuteRequest.parse(req.body);
  if (body.query.kind !== "sql") {
    throw new Error(`connector-supabase only accepts sql queries, got kind: ${body.query.kind}`);
  }
  const pool = await getPool(body.credential, body.config);
  const start = Date.now();
  const result = await executeWithStatementTimeout(
    pool,
    body.query.sql,
    body.query.params,
    body.timeoutMs,
  );
  const rowArr = result.rows as Array<Record<string, unknown>>;
  const truncated = rowArr.length > body.rowCap;
  const capped = truncated ? rowArr.slice(0, body.rowCap) : rowArr;
  const columns = (result.fields ?? []).map((f) => ({
    name: f.name,
    type: mapPostgresColumnType(f.dataTypeID),
  }));
  return {
    columns,
    rows: capped.map((r) => columns.map((c) => r[c.name])),
    meta: {
      executedQuery: body.query.sql,
      connectionId: body.credential.connectionId,
      durationMs: Date.now() - start,
      rowCount: capped.length,
      truncated,
    },
  };
});

/**
 * Phase 6 Block 2 — the write path. Structured input, not SQL text: this
 * builds the parameterized UPSERT itself (writeSql.ts) rather than routing
 * through @nia/guardrails' validateReadOnlySql, which is a hard read-only
 * allowlist and fundamentally can't accept a write. Row cap is
 * env-configurable (WRITE_ROW_CAP, default matches the kickoff spec's
 * 5000) and is a hard reject, not a truncate-and-continue like /execute's
 * rowCap — silently dropping rows a caller asked to persist would look
 * like a successful write that wasn't.
 *
 * Two independent checks before any SQL runs, mirroring the kickoff
 * spec's "worker-side check before dispatch + connector-side re-check":
 *   1. verifyWriteContext — the signed context's HMAC + freshness window.
 *   2. verifyActiveWriteGrant — a fresh service-role lookup of the grant
 *      by id, confirming it's still confirmed+unrevoked and its scope
 *      actually covers this entity's schema (not just trusting the
 *      worker's pre-dispatch check from moments earlier).
 * Request-vs-context entity/column equality is checked first so a stale
 * or mismatched signature can't be reused to authorize a different write
 * than the one it was actually signed for.
 */
const WRITE_ROW_CAP = Number(process.env.WRITE_ROW_CAP ?? 5000);

app.post("/write", async (req): Promise<WriteResponse> => {
  const body = WriteRequest.parse(req.body);

  if (body.rows.length > WRITE_ROW_CAP) {
    throw new Error(`write request has ${body.rows.length} rows, exceeding the ${WRITE_ROW_CAP}-row cap per call`);
  }
  for (const row of body.rows) {
    if (row.length !== body.columns.length) {
      throw new Error(`row has ${row.length} values, expected ${body.columns.length} (one per column)`);
    }
  }
  for (const key of body.upsertKeys) {
    if (!body.columns.includes(key)) {
      throw new Error(`upsertKey "${key}" is not present in columns`);
    }
  }

  if (body.entity.namespace !== body.context.entity.namespace || body.entity.name !== body.context.entity.name) {
    throw new Error("request entity does not match the signed context's entity");
  }
  const requestColumns = new Set(body.columns);
  const contextColumns = new Set(body.context.columns);
  const columnsMatch =
    requestColumns.size === contextColumns.size && [...requestColumns].every((c) => contextColumns.has(c));
  if (!columnsMatch) {
    throw new Error("request columns do not match the signed context's columns");
  }
  if (body.context.connectionId !== body.credential.connectionId) {
    throw new Error("signed context connectionId does not match the request credential");
  }

  const secret = process.env.WRITE_DISPATCH_SIGNING_SECRET;
  if (!secret) throw new Error("WRITE_DISPATCH_SIGNING_SECRET is not configured");
  const signatureValid = verifyWriteContext(
    {
      connectionId: body.context.connectionId,
      grantId: body.context.grantId,
      entity: body.context.entity,
      columns: body.context.columns,
      issuedAt: body.context.issuedAt,
    },
    body.context.signature,
    secret,
  );
  if (!signatureValid) throw new Error("write context signature is invalid or expired");

  const grantActive = await verifyActiveWriteGrant(
    body.context.grantId,
    body.context.connectionId,
    body.entity.namespace,
  );
  if (!grantActive) throw new Error("no confirmed, unrevoked write grant covers this entity");

  const pool = await getWritePool(body.credential, body.config);
  const sql = buildUpsertSql(body.entity, body.columns, body.upsertKeys, body.rows.length);
  const start = Date.now();
  const result = await executeWithStatementTimeout(pool, sql, body.rows.flat(), body.timeoutMs);
  return { written: result.rowCount ?? 0, durationMs: Date.now() - start };
});

app.post("/invalidate", async (req) => {
  const { connectionId } = InvalidateRequest.parse(req.body);
  return { evicted: await evict(connectionId) };
});

// Guarded so importing this module (e.g. from an integration test that
// drives routes via app.inject()) doesn't also try to bind a real socket.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4030);
  app.listen({ port, host: "0.0.0.0" }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}

export { app };
