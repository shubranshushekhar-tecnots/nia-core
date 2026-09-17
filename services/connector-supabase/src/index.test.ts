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

const verifyActiveWriteGrantMock = vi.fn();

vi.mock("./pool-manager.js", () => ({
  getPool: vi.fn(async () => ({ query: queryMock, connect: vi.fn(async () => makeClient()) })),
  getWritePool: vi.fn(async () => ({ query: queryMock, connect: vi.fn(async () => makeClient()) })),
  verifyActiveWriteGrant: (...args: unknown[]) => verifyActiveWriteGrantMock(...args),
  evict: vi.fn(async () => true),
  poolCount: vi.fn(() => 0),
}));

async function freshApp() {
  vi.resetModules();
  execMock.mockReset();
  releaseMock.mockReset();
  queryMock.mockReset();
  verifyActiveWriteGrantMock.mockReset();
  verifyActiveWriteGrantMock.mockResolvedValue(true);
  process.env.WRITE_DISPATCH_SIGNING_SECRET = "a".repeat(32);
  const mod = await import("./index.js");
  const { signWriteContext } = await import("./writeSignature.js");
  return { app: mod.app, signWriteContext };
}

const baseCredential = { connectionId: "11111111-1111-1111-1111-111111111111", credVersion: 1, vaultRef: "v1" };
const baseConfig = { host: "localhost", port: 5432, database: "testdb" };
const baseGrantId = "22222222-2222-2222-2222-222222222222";

describe("connector-supabase /execute (route-level)", () => {
  it("extracts sql/params from a { kind: 'sql' } payload, queries via a timeout-scoped transaction, and returns real ColumnTypes via dataTypeID", async () => {
    const { app } = await freshApp();
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
    const { app } = await freshApp();

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

describe("connector-supabase /write (route-level)", () => {
  const entity = { namespace: "sales", name: "orders" };
  const columns = ["id", "total"];

  function validPayload(app: { signWriteContext: (typeof import("./writeSignature.js"))["signWriteContext"] }, overrides: Record<string, unknown> = {}) {
    const issuedAt = Date.now();
    const signature = app.signWriteContext(
      { connectionId: baseCredential.connectionId, grantId: baseGrantId, entity, columns, issuedAt },
      "a".repeat(32),
    );
    return {
      credential: baseCredential,
      config: baseConfig,
      entity,
      columns,
      rows: [[1, 100]],
      upsertKeys: ["id"],
      context: { connectionId: baseCredential.connectionId, grantId: baseGrantId, entity, columns, issuedAt, signature },
      ...overrides,
    };
  }

  it("executes the UPSERT and returns {written, durationMs} for a valid, signed, grant-covered request", async () => {
    const { app, signWriteContext } = await freshApp();
    execMock.mockResolvedValue({ rows: [], rowCount: 1 });

    const res = await app.inject({ method: "POST", url: "/write", payload: validPayload({ signWriteContext }) });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ written: 1 });
    expect(execMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('INSERT INTO "sales"."orders"'), values: [1, 100] }),
    );
    expect(verifyActiveWriteGrantMock).toHaveBeenCalledWith(baseGrantId, baseCredential.connectionId, "sales");
  });

  it("rejects when rows exceed the row cap", async () => {
    const original = process.env.WRITE_ROW_CAP;
    process.env.WRITE_ROW_CAP = "1";
    try {
      const { app, signWriteContext } = await freshApp();
      const res = await app.inject({
        method: "POST",
        url: "/write",
        payload: validPayload({ signWriteContext }, { rows: [[1, 100], [2, 200]] }),
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().message).toMatch(/exceeding the/);
    } finally {
      process.env.WRITE_ROW_CAP = original;
    }
  });

  it("rejects when a row's length doesn't match the column count", async () => {
    const { app, signWriteContext } = await freshApp();
    const res = await app.inject({
      method: "POST",
      url: "/write",
      payload: validPayload({ signWriteContext }, { rows: [[1]] }),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().message).toMatch(/expected 2/);
  });

  it("rejects when an upsertKey isn't present in columns", async () => {
    const { app, signWriteContext } = await freshApp();
    const res = await app.inject({
      method: "POST",
      url: "/write",
      payload: validPayload({ signWriteContext }, { upsertKeys: ["sku"] }),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().message).toMatch(/not present in columns/);
  });

  it("rejects when the request entity doesn't match the signed context's entity", async () => {
    const { app, signWriteContext } = await freshApp();
    const res = await app.inject({
      method: "POST",
      url: "/write",
      payload: validPayload({ signWriteContext }, { entity: { namespace: "sales", name: "customers" } }),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().message).toMatch(/does not match the signed context's entity/);
  });

  it("rejects when the request columns don't match the signed context's columns", async () => {
    const { app, signWriteContext } = await freshApp();
    const res = await app.inject({
      method: "POST",
      url: "/write",
      payload: validPayload({ signWriteContext }, { columns: ["id", "total", "status"], rows: [[1, 100, "open"]] }),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().message).toMatch(/do not match the signed context's columns/);
  });

  it("rejects when the signed context's connectionId doesn't match the request credential", async () => {
    const { app, signWriteContext } = await freshApp();
    const issuedAt = Date.now();
    const otherConnectionId = "99999999-9999-9999-9999-999999999999";
    const signature = signWriteContext(
      { connectionId: otherConnectionId, grantId: baseGrantId, entity, columns, issuedAt },
      "a".repeat(32),
    );
    const res = await app.inject({
      method: "POST",
      url: "/write",
      payload: validPayload({ signWriteContext }, {
        context: { connectionId: otherConnectionId, grantId: baseGrantId, entity, columns, issuedAt, signature },
      }),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().message).toMatch(/does not match the request credential/);
  });

  it("rejects an invalid or tampered signature", async () => {
    const { app, signWriteContext } = await freshApp();
    const issuedAt = Date.now();
    const res = await app.inject({
      method: "POST",
      url: "/write",
      payload: validPayload({ signWriteContext }, {
        context: { connectionId: baseCredential.connectionId, grantId: baseGrantId, entity, columns, issuedAt, signature: "0".repeat(64) },
      }),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().message).toMatch(/signature is invalid or expired/);
  });

  it("rejects when verifyActiveWriteGrant returns false (revoked/unconfirmed/out-of-scope grant)", async () => {
    const { app, signWriteContext } = await freshApp();
    verifyActiveWriteGrantMock.mockResolvedValue(false);
    const res = await app.inject({ method: "POST", url: "/write", payload: validPayload({ signWriteContext }) });
    expect(res.statusCode).toBe(500);
    expect(res.json().message).toMatch(/no confirmed, unrevoked write grant/);
    expect(execMock).not.toHaveBeenCalled();
  });
});
