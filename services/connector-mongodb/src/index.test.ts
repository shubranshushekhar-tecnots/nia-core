import { describe, expect, it, vi } from "vitest";

// Route-level confirmation that /execute actually works under the new
// QueryPayload shape — not just that it typechecks. Only pool-manager is
// mocked (no real socket, no real Mongo); everything else — Zod parsing
// via ExecuteRequest, the body.query.kind guard, pulling collection/
// pipeline off body.query, flattening, and building meta.executedQuery —
// is the real, unmodified route handler from index.ts, driven via
// Fastify's in-process `.inject()` (no port is bound; see index.ts's
// import.meta.url guard).

const toArrayMock = vi.fn();
const aggregateMock = vi.fn(() => ({ toArray: toArrayMock }));
const bulkWriteMock = vi.fn(async () => ({ upsertedCount: 1, matchedCount: 0 }));
const collectionMock = vi.fn(() => ({ aggregate: aggregateMock, bulkWrite: bulkWriteMock }));
const verifyActiveWriteGrantMock = vi.fn(async () => true);
vi.mock("./pool-manager.js", () => ({
  getDb: vi.fn(async () => ({ collection: collectionMock })),
  getWriteDb: vi.fn(async () => ({ collection: collectionMock })),
  verifyActiveWriteGrant: verifyActiveWriteGrantMock,
  evict: vi.fn(async () => true),
  poolCount: vi.fn(() => 0),
}));

async function freshApp() {
  vi.resetModules();
  toArrayMock.mockReset();
  aggregateMock.mockClear();
  bulkWriteMock.mockClear();
  collectionMock.mockClear();
  verifyActiveWriteGrantMock.mockClear();
  process.env.WRITE_DISPATCH_SIGNING_SECRET = "a".repeat(32);
  const mod = await import("./index.js");
  const { signReadContext, signWriteContext } = await import("./writeSignature.js");
  return { app: mod.app, signReadContext, signWriteContext };
}

const baseCredential = { connectionId: "11111111-1111-1111-1111-111111111111", credVersion: 1, vaultRef: "v1" };
const baseConfig = { host: "localhost", port: 27017, database: "testdb" };

function readContext(
  signReadContext: (typeof import("./writeSignature.js"))["signReadContext"],
  route: "test" | "introspect" | "execute" | "invalidate" | "preflight",
  queryPayload: unknown = null,
) {
  const issuedAt = Date.now();
  const signature = signReadContext(
    { route, connectionId: baseCredential.connectionId, queryPayload: queryPayload === null ? null : JSON.stringify(queryPayload), issuedAt },
    "a".repeat(32),
  );
  return { issuedAt, signature };
}

describe("connector-mongodb /execute (route-level)", () => {
  it("extracts collection/pipeline from a { kind: 'mongo' } payload and returns a readable executedQuery", async () => {
    const { app, signReadContext } = await freshApp();
    toArrayMock.mockResolvedValue([{ _id: "1", total: 42 }]);

    const pipeline = [{ $match: { status: "paid" } }];
    const query = { kind: "mongo" as const, collection: "orders", pipeline };
    const res = await app.inject({
      method: "POST",
      url: "/execute",
      payload: {
        credential: baseCredential,
        config: baseConfig,
        query,
        context: readContext(signReadContext, "execute", query),
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(collectionMock).toHaveBeenCalledWith("orders");
    expect(aggregateMock).toHaveBeenCalledWith(pipeline, expect.objectContaining({ maxTimeMS: expect.any(Number) }));

    // Readable rendering, not a JSON-stuffed/double-encoded blob.
    expect(body.meta.executedQuery).toBe(`db.orders.aggregate(${JSON.stringify(pipeline)})`);
    expect(body.rows).toEqual([["1", 42]]);
  });

  it("wraps a BSON Binary field as a base64 WireBinaryValue, not a bare base64 string indistinguishable from text", async () => {
    const { app, signReadContext } = await freshApp();

    const payload = Buffer.from([0, 1, 2, 255, 254, 72, 101, 108, 108, 111]);
    const fakeBinary = { _bsontype: "Binary", value: () => payload };
    toArrayMock.mockResolvedValue([{ _id: "1", blob: fakeBinary }]);

    const pipeline = [{ $match: {} }];
    const query = { kind: "mongo" as const, collection: "files", pipeline };
    const res = await app.inject({
      method: "POST",
      url: "/execute",
      payload: {
        credential: baseCredential,
        config: baseConfig,
        query,
        context: readContext(signReadContext, "execute", query),
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rows).toEqual([["1", { __niaBytes: true, base64: payload.toString("base64") }]]);
  });

  it("rejects a { kind: 'sql' } payload with a clear error instead of silently misreading it", async () => {
    const { app, signReadContext } = await freshApp();

    const query = { kind: "sql" as const, sql: "SELECT 1", params: [] };
    const res = await app.inject({
      method: "POST",
      url: "/execute",
      payload: {
        credential: baseCredential,
        config: baseConfig,
        query,
        context: readContext(signReadContext, "execute", query),
      },
    });

    expect(res.statusCode).toBe(500);
    expect(collectionMock).not.toHaveBeenCalled();
    expect(res.json().message).toMatch(/only accepts mongo queries, got kind: sql/);
  });
});

// Phase 11 — connector-mongodb has no staging-lifecycle implementation
// (standalone mongo can't do atomic multi-document transactions); both
// routes refuse unconditionally with a message pointing to direct mode.
// See index.ts's comment above these routes for the full rationale.
const baseEntity = { namespace: "testdb", name: "orders" };
const baseContext = {
  connectionId: baseCredential.connectionId,
  grantId: "22222222-2222-2222-2222-222222222222",
  runId: "33333333-3333-3333-3333-333333333333",
  entity: baseEntity,
  columns: ["id", "total"],
  mode: "upsert" as const,
  stagingEntity: { namespace: "nia", name: "nia_stg_abc123" },
  quarantineEntity: null,
  issuedAt: Date.now(),
  signature: "irrelevant-never-checked",
  grantNamespace: baseEntity.namespace,
};

describe("connector-mongodb /stage (route-level)", () => {
  it("refuses staged mode with a message pointing to direct mode, without touching Mongo", async () => {
    const { app } = await freshApp();

    const res = await app.inject({
      method: "POST",
      url: "/stage",
      payload: {
        credential: baseCredential,
        config: baseConfig,
        op: "create",
        entity: baseEntity,
        stagingEntity: baseContext.stagingEntity,
        quarantineEntity: null,
        runId: baseContext.runId,
        mode: "upsert",
        upsertKeys: ["id"],
        context: baseContext,
      },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().message).toMatch(/does not support staged writes/);
    expect(collectionMock).not.toHaveBeenCalled();
  });
});

describe("connector-mongodb /preflight (route-level)", () => {
  it("reports staged mode as unavailable", async () => {
    const { app, signReadContext } = await freshApp();

    const res = await app.inject({
      method: "POST",
      url: "/preflight",
      payload: {
        credential: baseCredential,
        config: baseConfig,
        entity: baseEntity,
        upsertKeys: ["id"],
        context: readContext(signReadContext, "preflight"),
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.checks).toEqual([
      expect.objectContaining({ name: "stagedModeSupported", ok: false, message: expect.stringMatching(/does not support staged writes/) }),
    ]);
  });
});

describe("connector-mongodb /write (route-level)", () => {
  it("decodes a WireBinaryValue (__niaBytes/base64) back to a real Buffer before bulkWrite, so the driver stores genuine BSON Binary instead of a plain string", async () => {
    const { app, signWriteContext } = await freshApp();

    const payload = Buffer.from([0, 1, 2, 255, 254, 72, 101, 108, 108, 111]);
    const columns = ["id", "payload"];
    const issuedAt = Date.now();
    const contextInput = {
      connectionId: baseCredential.connectionId,
      grantId: baseContext.grantId,
      runId: baseContext.runId,
      entity: baseEntity,
      grantNamespace: baseEntity.namespace,
      columns,
      mode: "upsert" as const,
      stagingEntity: null,
      quarantineEntity: null,
      issuedAt,
    };
    const signature = signWriteContext(contextInput, "a".repeat(32));

    const res = await app.inject({
      method: "POST",
      url: "/write",
      payload: {
        credential: baseCredential,
        config: baseConfig,
        entity: baseEntity,
        columns,
        rows: [[1, { __niaBytes: true, base64: payload.toString("base64") }]],
        upsertKeys: ["id"],
        context: { ...contextInput, signature },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ written: 1 });
    expect(bulkWriteMock).toHaveBeenCalledTimes(1);
    const ops = bulkWriteMock.mock.calls[0]![0] as Array<{ replaceOne: { replacement: Record<string, unknown> } }>;
    const writtenPayload = ops[0]!.replaceOne.replacement.payload;
    expect(Buffer.isBuffer(writtenPayload)).toBe(true);
    expect((writtenPayload as Buffer).equals(payload)).toBe(true);
  });
});
