import Fastify from "fastify";
import { ObjectId } from "mongodb";
import {
  TestRequest,
  IntrospectRequest,
  ExecuteRequest,
  InvalidateRequest,
  type TabularResult,
} from "@nia/schemas";
import { getDb, evict, poolCount } from "./pool-manager.js";
import { flattenDocuments } from "./flatten.js";
import { resolveColumnType, serializeCellValue } from "./column-types.js";

/**
 * apps/worker's queryBuilder.ts (Phase 6 Block 3.5) sends _id cursor values
 * as plain hex strings over the wire (QueryPayload's mongo pipeline is
 * `Record<string, unknown>[]`, JSON over HTTP — there's no BSON ObjectId
 * type on that transport). A bare string in `{_id: {$gt: "<hex>"}}` would
 * silently never match anything: BSON type-orders ObjectId and string
 * separately, so the comparison is well-formed but vacuous, not an error.
 * This rehydrates any string-valued _id comparison back into a real
 * ObjectId (only when it's a valid 24-hex-char ObjectId string, so
 * collections with non-ObjectId _id values — plain strings/numbers — pass
 * through unmodified and keyset pagination still works for them natively).
 */
function hydrateObjectIdCursor(pipeline: Record<string, unknown>[]): Record<string, unknown>[] {
  return pipeline.map((stage) => {
    const match = stage.$match as Record<string, unknown> | undefined;
    if (!match || typeof match !== "object" || !("_id" in match)) return stage;
    const idCond = match._id;
    if (!idCond || typeof idCond !== "object") return stage;
    const rehydrated: Record<string, unknown> = {};
    for (const [op, value] of Object.entries(idCond as Record<string, unknown>)) {
      rehydrated[op] = typeof value === "string" && ObjectId.isValid(value) ? new ObjectId(value) : value;
    }
    return { ...stage, $match: { ...match, _id: rehydrated } };
  });
}

/**
 * connector-mongodb — mirrors connector-mysql's contract exactly:
 * /test /introspect /execute /invalidate /health.
 *
 * ExecuteRequest.query is the shared discriminated QueryPayload
 * (see @nia/schemas contract.ts); this service only accepts the
 * `{ kind: "mongo", collection, pipeline }` variant, produced by the
 * worker's @nia/guardrails validateBeforeDispatch("mongodb", ...) call.
 */

const SAMPLE_SIZE = 50;

const app = Fastify({ logger: true });

app.get("/health", async () => ({
  status: "ok" as const,
  service: "connector-mongodb",
  pools: poolCount(),
  routes: ["test", "introspect", "execute", "invalidate"],
}));

app.post("/test", async (req) => {
  const { credential, config } = TestRequest.parse(req.body);
  const start = Date.now();
  try {
    const db = await getDb(credential, config);
    await db.command({ ping: 1 });
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "unknown" };
  }
});

app.post("/introspect", async (req) => {
  const { credential, config } = IntrospectRequest.parse(req.body);
  const db = await getDb(credential, config);
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  const entities = [];
  for (const collInfo of collections) {
    const samples = await db
      .collection(collInfo.name)
      .aggregate([{ $sample: { size: SAMPLE_SIZE } }])
      .toArray();
    const { columns, arrayColumns, rows } = flattenDocuments(samples);
    const fields = columns.map((name) => ({
      name,
      type: resolveColumnType(arrayColumns.has(name), rows.map((r) => r[name])),
    }));
    // primaryKey stays null — queryBuilder.ts always keys Mongo off `_id`
    // (unconditionally unique) regardless of this field, so there's
    // nothing to discover here. IntrospectResponse.primaryKey defaults to
    // null on parse either way; set explicitly for readability.
    entities.push({ namespace: String(config.database ?? ""), name: collInfo.name, fields, primaryKey: null });
  }
  return { entities };
});

app.post("/execute", async (req): Promise<TabularResult> => {
  const body = ExecuteRequest.parse(req.body);
  if (body.query.kind !== "mongo") {
    throw new Error(`connector-mongodb only accepts mongo queries, got kind: ${body.query.kind}`);
  }
  const { collection } = body.query;
  const pipeline = hydrateObjectIdCursor(body.query.pipeline);
  const db = await getDb(body.credential, body.config);
  const start = Date.now();
  const docs = await db
    .collection(collection)
    .aggregate(pipeline, { maxTimeMS: body.timeoutMs })
    .toArray();
  const truncated = docs.length > body.rowCap;
  const capped = truncated ? docs.slice(0, body.rowCap) : docs;
  const { columns, arrayColumns, rows } = flattenDocuments(capped);
  const columnDefs = columns.map((name) => ({
    name,
    type: resolveColumnType(arrayColumns.has(name), rows.map((r) => r[name])),
  }));
  return {
    columns: columnDefs,
    rows: rows.map((r) => columnDefs.map((c) => serializeCellValue(r[c.name]))),
    meta: {
      // Readable rendering for citations — not the raw wire payload.
      executedQuery: `db.${collection}.aggregate(${JSON.stringify(pipeline)})`,
      connectionId: body.credential.connectionId,
      durationMs: Date.now() - start,
      rowCount: rows.length,
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
  const port = Number(process.env.PORT ?? 4020);
  app.listen({ port, host: "0.0.0.0" }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}

export { app };
