import Fastify from "fastify";
import { ObjectId } from "mongodb";
import {
  TestRequest,
  IntrospectRequest,
  ExecuteRequest,
  InvalidateRequest,
  WriteRequest,
  StageRequest,
  PreflightRequest,
  CreateEntityRequest,
  type TabularResult,
  type WriteResponse,
  type StageResponse,
  type PreflightResponse,
  type CreateEntityResponse,
} from "@nia/schemas";
import { getDb, getWriteDb, evict, poolCount, verifyActiveWriteGrant } from "./pool-manager.js";
import { flattenDocuments } from "./flatten.js";
import { resolveColumnType, serializeCellValue } from "./column-types.js";
import { verifyWriteContext } from "./writeSignature.js";
import { buildBulkWriteOps } from "./writeOps.js";

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
 * /test /introspect /execute /invalidate /health, plus /write (Phase 6
 * Block 5 — this connector's etl_sink capability).
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
  routes: ["test", "introspect", "execute", "invalidate", "write", "stage", "preflight", "create-entity"],
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
    const { columns, arrayColumns, degradedColumns, rows } = flattenDocuments(samples);
    const fields = columns.map((name) => ({
      name,
      type: resolveColumnType(arrayColumns.has(name), rows.map((r) => r[name])),
      degraded: degradedColumns.has(name),
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
  const { columns, arrayColumns, degradedColumns, rows } = flattenDocuments(capped);
  const columnDefs = columns.map((name) => ({
    name,
    type: resolveColumnType(arrayColumns.has(name), rows.map((r) => r[name])),
    degraded: degradedColumns.has(name),
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

/**
 * Phase 6 Block 5 — write path. Mirrors connector-mysql/connector-supabase's
 * /write exactly (same validation order, same two independent checks before
 * anything runs: verifyWriteContext's HMAC+freshness, then a fresh
 * verifyActiveWriteGrant lookup) — see connector-supabase/src/index.ts's
 * header comment for the full rationale. Only difference is dialect:
 * buildBulkWriteOps (writeOps.ts) produces `bulkWrite` replaceOne/upsert
 * operations instead of parameterized SQL text. entity.name is the target
 * collection; entity.namespace is the database (matches /introspect's
 * `namespace: config.database` convention), used only for the grant-scope
 * check below, not to select a different database than the pooled
 * connection's own (config.database).
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
      runId: body.context.runId,
      entity: body.context.entity,
      columns: body.context.columns,
      mode: body.context.mode,
      stagingEntity: body.context.stagingEntity,
      quarantineEntity: body.context.quarantineEntity,
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

  const db = await getWriteDb(body.credential, body.config);
  const ops = buildBulkWriteOps(body.columns, body.upsertKeys, body.rows);
  const start = Date.now();
  const result = await db.collection(body.entity.name).bulkWrite(ops);
  const written = result.upsertedCount + result.matchedCount;
  return { written, durationMs: Date.now() - start };
});

/**
 * Phase 11 Block 2A/2B/2D — connector-mongodb does NOT implement the
 * staging lifecycle. Atomic apply-from-staging (Block 2B) needs the
 * create-staging + write-to-staging + apply-in-one-transaction sequence to
 * be genuinely atomic, which on MongoDB means multi-document transactions
 * — only available on a replica set (or sharded cluster), never on a
 * standalone `mongod`. This codebase's sandbox/dev mongo topology is
 * standalone (see docs/decisions.md's Phase 11 entry), and detecting
 * "is this deployment a replica set" per-connection (via `hello`/
 * `isMaster` and `db.admin().command({replSetGetStatus:1})`) to
 * conditionally support staging only on replica-set connections is out of
 * scope for this phase — this is the plan's own documented fallback:
 * "On standalone mongo, refuse staged mode with a clear message pointing
 * to direct mode." Both routes below refuse unconditionally, regardless
 * of the actual connection's topology, rather than half-implementing a
 * topology probe with no way to exercise the transactional path in this
 * environment. `/stage` still Zod-parses the request (so malformed
 * payloads fail the same way they would anywhere else) but never opens a
 * connection or touches Mongo — there is nothing to verify a signature
 * against, since no mutation ever happens.
 */
const STAGED_MODE_UNSUPPORTED_MESSAGE =
  "connector-mongodb does not support staged writes: atomic apply-from-staging requires multi-document " +
  "transactions, which are only available on a MongoDB replica set (or sharded cluster), never on a standalone " +
  "mongod. Use direct mode (a WriteRequest with no stagingEntity) for this connection instead.";

app.post("/stage", async (req): Promise<StageResponse> => {
  StageRequest.parse(req.body);
  throw new Error(STAGED_MODE_UNSUPPORTED_MESSAGE);
});

app.post("/preflight", async (req): Promise<PreflightResponse> => {
  PreflightRequest.parse(req.body);
  return {
    ok: false,
    checks: [{ name: "stagedModeSupported", ok: false, message: STAGED_MODE_UNSUPPORTED_MESSAGE }],
  };
});

/**
 * Schema layer, Part 4 — destination creation. `kind` must be
 * "collection". Mongo has no column DDL to run (a collection has no fixed
 * schema) — `body.columns` is still signature-bound and validated for
 * name-set match (same posture as the SQL connectors: the signed context
 * names exactly what's being created), but only `keys` drives an actual
 * mutation, as a unique index. `createCollection` is called through
 * `listCollections`-first (idempotent equivalent of the SQL connectors'
 * `IF NOT EXISTS` — the MongoDB driver's createCollection throws
 * NamespaceExists on a second call, unlike SQL's `IF NOT EXISTS` clause).
 */
app.post("/create-entity", async (req): Promise<CreateEntityResponse> => {
  const body = CreateEntityRequest.parse(req.body);
  const start = Date.now();

  if (body.kind !== "collection") {
    throw new Error(`connector-mongodb only creates collections, got kind: ${body.kind}`);
  }
  if (body.context.connectionId !== body.credential.connectionId) {
    throw new Error("signed context connectionId does not match the request credential");
  }
  if (body.entity.namespace !== body.context.entity.namespace || body.entity.name !== body.context.entity.name) {
    throw new Error("request entity does not match the signed context's entity");
  }
  const requestColumns = new Set(body.columns.map((c) => c.name));
  const contextColumns = new Set(body.context.columns);
  const columnsMatch =
    requestColumns.size === contextColumns.size && [...requestColumns].every((c) => contextColumns.has(c));
  if (!columnsMatch) {
    throw new Error("request columns do not match the signed context's columns");
  }
  for (const key of body.keys) {
    if (!requestColumns.has(key)) {
      throw new Error(`key column "${key}" is not present in columns`);
    }
  }

  const secret = process.env.WRITE_DISPATCH_SIGNING_SECRET;
  if (!secret) throw new Error("WRITE_DISPATCH_SIGNING_SECRET is not configured");
  const signatureValid = verifyWriteContext(
    {
      connectionId: body.context.connectionId,
      grantId: body.context.grantId,
      runId: body.context.runId,
      entity: body.context.entity,
      columns: body.context.columns,
      mode: body.context.mode,
      stagingEntity: body.context.stagingEntity,
      quarantineEntity: body.context.quarantineEntity,
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

  const db = await getWriteDb(body.credential, body.config);
  const existing = await db.listCollections({ name: body.entity.name }, { nameOnly: true }).toArray();
  let created = false;
  if (existing.length === 0) {
    await db.createCollection(body.entity.name);
    created = true;
  }
  if (body.keys.length > 0) {
    const indexSpec = Object.fromEntries(body.keys.map((k) => [k, 1] as const));
    await db.collection(body.entity.name).createIndex(indexSpec, { unique: true });
  }

  return { created, durationMs: Date.now() - start };
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
