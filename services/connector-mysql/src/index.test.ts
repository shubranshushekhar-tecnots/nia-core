import { describe, expect, it, vi } from "vitest";

// Route-level confirmation that /execute actually works under the new
// QueryPayload shape — not just that it typechecks. Only pool-manager is
// mocked (no real socket, no real MySQL); everything else — Zod parsing
// via ExecuteRequest, the body.query.kind guard, pulling sql/params off
// body.query, and building the tabular response/meta — is the real,
// unmodified route handler from index.ts, driven via Fastify's in-process
// `.inject()` (no port is bound; see index.ts's import.meta.url guard).

const queryMock = vi.fn();
vi.mock("./pool-manager.js", () => ({
  getPool: vi.fn(async () => ({ query: queryMock })),
  evict: vi.fn(async () => true),
  poolCount: vi.fn(() => 0),
}));

async function freshApp() {
  vi.resetModules();
  queryMock.mockReset();
  const mod = await import("./index.js");
  return mod.app;
}

const baseCredential = { connectionId: "11111111-1111-1111-1111-111111111111", credVersion: 1, vaultRef: "v1" };
const baseConfig = { host: "localhost", port: 3306, database: "testdb" };

describe("connector-mysql /execute (route-level)", () => {
  it("extracts sql/params from a { kind: 'sql' } payload, queries the pool, and returns a readable executedQuery", async () => {
    const app = await freshApp();
    queryMock.mockResolvedValue([
      [{ id: 1, name: "Ada" }],
      [{ name: "id" }, { name: "name" }],
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/execute",
      payload: {
        credential: baseCredential,
        config: baseConfig,
        query: { kind: "sql", sql: "SELECT id, name FROM users WHERE id = ?", params: [1] },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // The mocked pool.query was called with the sql/params pulled off
    // body.query — not a stringified blob, not the old top-level `params`.
    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({ sql: "SELECT id, name FROM users WHERE id = ?", values: [1] }),
    );

    // meta.executedQuery is the raw SQL text, readable for citations.
    expect(body.meta.executedQuery).toBe("SELECT id, name FROM users WHERE id = ?");
    expect(body.rows).toEqual([[1, "Ada"]]);
    expect(body.columns.map((c: { name: string }) => c.name)).toEqual(["id", "name"]);
  });

  it("rejects a { kind: 'mongo' } payload with a clear error instead of silently misreading it", async () => {
    const app = await freshApp();

    const res = await app.inject({
      method: "POST",
      url: "/execute",
      payload: {
        credential: baseCredential,
        config: baseConfig,
        query: { kind: "mongo", collection: "orders", pipeline: [] },
      },
    });

    expect(res.statusCode).toBe(500);
    expect(queryMock).not.toHaveBeenCalled();
    expect(res.json().message).toMatch(/only accepts sql queries, got kind: mongo/);
  });
});
