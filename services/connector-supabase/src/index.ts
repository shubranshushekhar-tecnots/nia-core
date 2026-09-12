import Fastify from "fastify";
import {
  TestRequest,
  IntrospectRequest,
  ExecuteRequest,
  InvalidateRequest,
  type TabularResult,
} from "@nia/schemas";
import { getPool, evict, poolCount } from "./pool-manager.js";
import { mapPostgresColumnType } from "./column-types.js";
import { executeWithStatementTimeout } from "./query.js";

/**
 * connector-supabase — direct Postgres access (targets a Supabase project's
 * underlying Postgres, not its REST/PostgREST API). Same uniform contract as
 * connector-mysql/connector-mongodb: /test /introspect /execute /invalidate
 * /health.
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
