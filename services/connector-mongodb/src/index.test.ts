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
const collectionMock = vi.fn(() => ({ aggregate: aggregateMock }));
vi.mock("./pool-manager.js", () => ({
  getDb: vi.fn(async () => ({ collection: collectionMock })),
  evict: vi.fn(async () => true),
  poolCount: vi.fn(() => 0),
}));

async function freshApp() {
  vi.resetModules();
  toArrayMock.mockReset();
  aggregateMock.mockClear();
  collectionMock.mockClear();
  const mod = await import("./index.js");
  return mod.app;
}

const baseCredential = { connectionId: "11111111-1111-1111-1111-111111111111", credVersion: 1, vaultRef: "v1" };
const baseConfig = { host: "localhost", port: 27017, database: "testdb" };

describe("connector-mongodb /execute (route-level)", () => {
  it("extracts collection/pipeline from a { kind: 'mongo' } payload and returns a readable executedQuery", async () => {
    const app = await freshApp();
    toArrayMock.mockResolvedValue([{ _id: "1", total: 42 }]);

    const pipeline = [{ $match: { status: "paid" } }];
    const res = await app.inject({
      method: "POST",
      url: "/execute",
      payload: {
        credential: baseCredential,
        config: baseConfig,
        query: { kind: "mongo", collection: "orders", pipeline },
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

  it("rejects a { kind: 'sql' } payload with a clear error instead of silently misreading it", async () => {
    const app = await freshApp();

    const res = await app.inject({
      method: "POST",
      url: "/execute",
      payload: {
        credential: baseCredential,
        config: baseConfig,
        query: { kind: "sql", sql: "SELECT 1", params: [] },
      },
    });

    expect(res.statusCode).toBe(500);
    expect(collectionMock).not.toHaveBeenCalled();
    expect(res.json().message).toMatch(/only accepts mongo queries, got kind: sql/);
  });
});
