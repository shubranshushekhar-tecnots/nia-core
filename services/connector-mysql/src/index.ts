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
import { verifyWriteContext } from "./writeSignature.js";
import { buildUpsertSql } from "./writeSql.js";

/**
 * connector-mysql — one shared service per tool type on the internal Docker
 * network. Uniform contract: /test /introspect /execute /invalidate /health,
 * plus /write (Phase 6 Block 5 — this connector's etl_sink capability,
 * mirroring connector-supabase's write path exactly, just MySQL-dialect).
 *
 * The worker sends dialect-native, guardrail-approved queries. This service's
 * jobs are pooling, execution, and normalization to the tabular shape.
 */

const app = Fastify({ logger: true });

app.get("/health", async () => ({
  status: "ok" as const,
  service: "connector-mysql",
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
  // information_schema.columns is implemented as a view with uppercase
  // column definitions — MySQL returns TABLE_SCHEMA/TABLE_NAME/etc.
  // regardless of the case used in this query text, so explicit lowercase
  // aliases are required (not just style) to make the destructuring below
  // actually populate instead of silently reading `undefined`.
  //
  // column_key is native to information_schema.columns ('PRI' marks a
  // primary-key column) — no join needed here, unlike Postgres (see
  // connector-supabase's /introspect). Phase 6 Block 3.5: this is what
  // lets IntrospectResponse report a verified-unique key per entity for
  // the ETL runner's keyset pagination.
  const [rows] = await pool.query(
    `SELECT table_schema AS table_schema, table_name AS table_name,
            column_name AS column_name, data_type AS data_type,
            column_key AS column_key
     FROM information_schema.columns
     WHERE table_schema NOT IN ('information_schema','mysql','performance_schema','sys')
     ORDER BY table_schema, table_name, ordinal_position`,
  );
  const byEntity = new Map<
    string,
    { namespace: string; name: string; fields: { name: string; type: string }[]; primaryKeyCols: string[] }
  >();
  for (const r of rows as Array<Record<string, string>>) {
    const key = `${r.table_schema}.${r.table_name}`;
    if (!byEntity.has(key)) {
      byEntity.set(key, { namespace: r.table_schema!, name: r.table_name!, fields: [], primaryKeyCols: [] });
    }
    const entity = byEntity.get(key)!;
    entity.fields.push({ name: r.column_name!, type: r.data_type! });
    if (r.column_key === "PRI") entity.primaryKeyCols.push(r.column_name!);
  }
  // Single-column PK only — a composite PK can't drive keyset pagination
  // (WHERE key > cursor needs one orderable value), so it's reported the
  // same as "no key found" (null) rather than picking one column.
  return {
    entities: [...byEntity.values()].map(({ primaryKeyCols, ...entity }) => ({
      ...entity,
      primaryKey: primaryKeyCols.length === 1 ? primaryKeyCols[0]! : null,
    })),
  };
});

app.post("/execute", async (req): Promise<TabularResult> => {
  const body = ExecuteRequest.parse(req.body);
  if (body.query.kind !== "sql") {
    throw new Error(`connector-mysql only accepts sql queries, got kind: ${body.query.kind}`);
  }
  const pool = await getPool(body.credential, body.config);
  const start = Date.now();
  const [rows, fields] = await pool.query({
    sql: body.query.sql,
    values: body.query.params,
    timeout: body.timeoutMs,
  });
  const rowArr = rows as Array<Record<string, unknown>>;
  const truncated = rowArr.length > body.rowCap;
  const capped = truncated ? rowArr.slice(0, body.rowCap) : rowArr;
  const columns = (fields ?? []).map((f) => ({
    name: f.name,
    type: "unknown" as const, // TODO: map mysql2 field types → ColumnType
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
 * Phase 6 Block 5 — write path. Mirrors connector-supabase's /write exactly
 * (same validation order, same two independent checks before any SQL runs:
 * verifyWriteContext's HMAC+freshness, then a fresh verifyActiveWriteGrant
 * lookup) — see that file's header comment for the full rationale. Only
 * difference is dialect: buildUpsertSql (writeSql.ts) emits MySQL's
 * `ON DUPLICATE KEY UPDATE` instead of Postgres's `ON CONFLICT`, and this
 * runs the statement via pool.query directly (mysql2's client-side
 * `timeout` option) rather than a executeWithStatementTimeout wrapper —
 * connector-mysql has never had one; /execute above uses the same
 * pool.query({sql, values, timeout}) shape.
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
  const [result] = await pool.query({
    sql,
    values: body.rows.flat(),
    timeout: body.timeoutMs,
  });
  const written = (result as { affectedRows?: number }).affectedRows ?? 0;
  return { written, durationMs: Date.now() - start };
});

app.post("/invalidate", async (req) => {
  const { connectionId } = InvalidateRequest.parse(req.body);
  return { evicted: await evict(connectionId) };
});

// Guarded so importing this module (e.g. from an integration test that
// drives routes via app.inject()) doesn't also try to bind a real socket.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4010);
  app.listen({ port, host: "0.0.0.0" }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}

export { app };
