import { describe, expect, it, vi } from "vitest";

// Route-level confirmation that /execute actually works under the
// QueryPayload shape and pg's {rows, fields} result shape — not just that
// it typechecks. Only pool-manager is mocked (no real socket, no real
// Postgres); everything else — Zod parsing via ExecuteRequest, the
// body.query.kind guard, pulling sql/params off body.query, the real
// executeWithStatementTimeout wrapper (query.ts), real ColumnType mapping
// via column-types.ts, and building the tabular response/meta — is the
// real, unmodified route handler from index.ts, driven via Fastify's
// in-process `.inject()` (no port is bound; see index.ts's
// import.meta.url guard).

// execMock stands in for the "real" data query — BEGIN/SET LOCAL/COMMIT
// (issued by query.ts's executeWithStatementTimeout) are handled inline by
// the fake client below so they don't need their own assertions here;
// query.test.ts already covers that wiring in isolation.
const execMock = vi.fn();
const releaseMock = vi.fn();
const queryMock = vi.fn();

function makeClient() {
  return {
    query: vi.fn(async (q: string | { text: string; values?: unknown[] }) => {
      const text = typeof q === "string" ? q : q.text;
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || /^SET LOCAL/.test(text)) {
        return { rows: [], fields: [] };
      }
      return execMock(q);
    }),
    release: releaseMock,
  };
}

vi.mock("./pool-manager.js", () => ({
  getPool: vi.fn(async () => ({ query: queryMock, connect: vi.fn(async () => makeClient()) })),
  evict: vi.fn(async () => true),
  poolCount: vi.fn(() => 0),
}));

async function freshApp() {
  vi.resetModules();
  execMock.mockReset();
  releaseMock.mockReset();
  queryMock.mockReset();
  const mod = await import("./index.js");
  return mod.app;
}

const baseCredential = { connectionId: "11111111-1111-1111-1111-111111111111", credVersion: 1, vaultRef: "v1" };
const baseConfig = { host: "localhost", port: 5432, database: "testdb" };

describe("connector-supabase /execute (route-level)", () => {
  it("extracts sql/params from a { kind: 'sql' } payload, queries via a timeout-scoped transaction, and returns real ColumnTypes via dataTypeID", async () => {
    const app = await freshApp();
    execMock.mockResolvedValue({
      rows: [{ id: 1, name: "Ada" }],
      fields: [
        { name: "id", dataTypeID: 23 }, // int4 -> number
        { name: "name", dataTypeID: 25 }, // text -> string
      ],
    });

    const res = await app.inject({
      method: "POST",
      url: "/execute",
      payload: {
        credential: baseCredential,
        config: baseConfig,
        query: { kind: "sql", sql: "SELECT id, name FROM users WHERE id = $1", params: [1] },
        timeoutMs: 7000,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // The real query was issued with the object form {text, values} pulled
    // off body.query — not the mysql2 positional form.
    expect(execMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: "SELECT id, name FROM users WHERE id = $1", values: [1] }),
    );
    expect(releaseMock).toHaveBeenCalledOnce();

    // meta.executedQuery is the raw SQL text, readable for citations.
    expect(body.meta.executedQuery).toBe("SELECT id, name FROM users WHERE id = $1");
    expect(body.rows).toEqual([[1, "Ada"]]);
    expect(body.columns).toEqual([
      { name: "id", type: "number" },
      { name: "name", type: "string" },
    ]);
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
    expect(execMock).not.toHaveBeenCalled();
    expect(res.json().message).toMatch(/only accepts sql queries, got kind: mongo/);
  });
});
