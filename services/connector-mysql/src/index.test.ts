import { describe, expect, it, vi } from "vitest";

// Route-level confirmation that /execute actually works under the new
// QueryPayload shape — not just that it typechecks. Only pool-manager is
// mocked (no real socket, no real MySQL); everything else — Zod parsing
// via ExecuteRequest, the body.query.kind guard, pulling sql/params off
// body.query, and building the tabular response/meta — is the real,
// unmodified route handler from index.ts, driven via Fastify's in-process
// `.inject()` (no port is bound; see index.ts's import.meta.url guard).

const queryMock = vi.fn();

// execMock stands in for a "real" connection.query call inside /write and
// /stage — mysql2's tuple return shape ([rows|ResultSetHeader, fields]) is
// reproduced by execMock's resolved value, not by makeConnection itself, so
// each test controls exactly what a given SQL statement returns.
const execMock = vi.fn();
const releaseMock = vi.fn();
const beginTransactionMock = vi.fn();
const commitMock = vi.fn();
const rollbackMock = vi.fn();

function makeConnection() {
  return {
    query: vi.fn(async (sql: string, values?: unknown[]) => execMock(sql, values)),
    beginTransaction: beginTransactionMock,
    commit: commitMock,
    rollback: rollbackMock,
    release: releaseMock,
  };
}

const verifyActiveWriteGrantMock = vi.fn();

vi.mock("./pool-manager.js", () => ({
  getPool: vi.fn(async () => ({ query: queryMock })),
  getWritePool: vi.fn(async () => ({ query: queryMock, getConnection: vi.fn(async () => makeConnection()) })),
  verifyActiveWriteGrant: (...args: unknown[]) => verifyActiveWriteGrantMock(...args),
  evict: vi.fn(async () => true),
  poolCount: vi.fn(() => 0),
}));

async function freshApp() {
  vi.resetModules();
  queryMock.mockReset();
  execMock.mockReset();
  execMock.mockResolvedValue([{ affectedRows: 0 }, undefined]);
  releaseMock.mockReset();
  beginTransactionMock.mockReset();
  commitMock.mockReset();
  rollbackMock.mockReset();
  verifyActiveWriteGrantMock.mockReset();
  verifyActiveWriteGrantMock.mockResolvedValue(true);
  process.env.WRITE_DISPATCH_SIGNING_SECRET = "a".repeat(32);
  const mod = await import("./index.js");
  const { signWriteContext } = await import("./writeSignature.js");
  return { app: mod.app, signWriteContext };
}

const baseCredential = { connectionId: "11111111-1111-1111-1111-111111111111", credVersion: 1, vaultRef: "v1" };
const baseConfig = { host: "localhost", port: 3306, database: "testdb" };
const baseGrantId = "22222222-2222-2222-2222-222222222222";

describe("connector-mysql /execute (route-level)", () => {
  it("extracts sql/params from a { kind: 'sql' } payload, queries the pool, and returns a readable executedQuery", async () => {
    const { app } = await freshApp();
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
    expect(queryMock).not.toHaveBeenCalled();
    expect(res.json().message).toMatch(/only accepts sql queries, got kind: mongo/);
  });
});

describe("connector-mysql /write (route-level)", () => {
  const entity = { namespace: "sales", name: "orders" };
  const columns = ["id", "total"];
  const stagingFields = { runId: null, mode: "upsert" as const, stagingEntity: null, quarantineEntity: null };

  function validPayload(app: { signWriteContext: (typeof import("./writeSignature.js"))["signWriteContext"] }, overrides: Record<string, unknown> = {}) {
    const issuedAt = Date.now();
    const signature = app.signWriteContext(
      { connectionId: baseCredential.connectionId, grantId: baseGrantId, entity, columns, issuedAt, ...stagingFields },
      "a".repeat(32),
    );
    return {
      credential: baseCredential,
      config: baseConfig,
      entity,
      columns,
      rows: [[1, 100]],
      upsertKeys: ["id"],
      context: { connectionId: baseCredential.connectionId, grantId: baseGrantId, entity, columns, issuedAt, signature, ...stagingFields },
      ...overrides,
    };
  }

  it("executes the UPSERT and returns {written, durationMs} for a valid, signed, grant-covered request", async () => {
    const { app, signWriteContext } = await freshApp();
    queryMock.mockResolvedValue([{ affectedRows: 1 }, undefined]);

    const res = await app.inject({ method: "POST", url: "/write", payload: validPayload({ signWriteContext }) });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ written: 1 });
    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({ sql: expect.stringContaining("INSERT INTO `sales`.`orders`"), values: [1, 100] }),
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

  it("rejects an invalid or tampered signature", async () => {
    const { app, signWriteContext } = await freshApp();
    const issuedAt = Date.now();
    const res = await app.inject({
      method: "POST",
      url: "/write",
      payload: validPayload({ signWriteContext }, {
        context: { connectionId: baseCredential.connectionId, grantId: baseGrantId, entity, columns, issuedAt, signature: "0".repeat(64), ...stagingFields },
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
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("JSON.stringify's an object/array value bound for a JSON-typed destination column, after looking up its type", async () => {
    const { app, signWriteContext } = await freshApp();
    // First pool.query call is the destination-column-type lookup
    // (rowsNeedJsonCoercion sees an object value in the batch), second is
    // the UPSERT itself — queryMock is shared, so each call is queued in
    // call order via mockResolvedValueOnce.
    queryMock.mockResolvedValueOnce([[{ column_name: "id", data_type: "int" }, { column_name: "payload", data_type: "json" }]]);
    queryMock.mockResolvedValueOnce([{ affectedRows: 1 }, undefined]);

    const issuedAt = Date.now();
    const columns = ["id", "payload"];
    const signature = signWriteContext(
      { connectionId: baseCredential.connectionId, grantId: baseGrantId, entity, columns, issuedAt, ...stagingFields },
      "a".repeat(32),
    );
    const res = await app.inject({
      method: "POST",
      url: "/write",
      payload: {
        credential: baseCredential,
        config: baseConfig,
        entity,
        columns,
        rows: [[1, { a: 1, b: [2, 3] }]],
        upsertKeys: ["id"],
        context: { connectionId: baseCredential.connectionId, grantId: baseGrantId, entity, columns, issuedAt, signature, ...stagingFields },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ written: 1 });
    expect(queryMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ values: [1, JSON.stringify({ a: 1, b: [2, 3] })] }),
    );
  });

  it("refuses with a clear error when an object/array value targets a non-JSON destination column, without writing anything", async () => {
    const { app, signWriteContext } = await freshApp();
    queryMock.mockResolvedValueOnce([[{ column_name: "id", data_type: "int" }, { column_name: "total", data_type: "decimal" }]]);

    const issuedAt = Date.now();
    const columns = ["id", "total"];
    const signature = signWriteContext(
      { connectionId: baseCredential.connectionId, grantId: baseGrantId, entity, columns, issuedAt, ...stagingFields },
      "a".repeat(32),
    );
    const res = await app.inject({
      method: "POST",
      url: "/write",
      payload: {
        credential: baseCredential,
        config: baseConfig,
        entity,
        columns,
        rows: [[1, { not: "a scalar" }]],
        upsertKeys: ["id"],
        context: { connectionId: baseCredential.connectionId, grantId: baseGrantId, entity, columns, issuedAt, signature, ...stagingFields },
      },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().message).toMatch(/destination type is not JSON — refusing to write it/);
    // Only the type-lookup query ran — no UPSERT was ever issued.
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("writes a quarantine row (entity == context.quarantineEntity) via the fixed quarantine-table INSERT, not the upsert path", async () => {
    const { app, signWriteContext } = await freshApp();
    execMock.mockResolvedValue([{ affectedRows: 1 }, undefined]);
    const quarantineEntity = { namespace: "nia", name: "nia_quarantine" };
    const runId = "33333333-3333-3333-3333-333333333333";
    const issuedAt = Date.now();
    const signature = signWriteContext(
      { connectionId: baseCredential.connectionId, grantId: baseGrantId, runId, entity, columns, mode: "upsert", stagingEntity: null, quarantineEntity, issuedAt },
      "a".repeat(32),
    );
    const res = await app.inject({
      method: "POST",
      url: "/write",
      payload: {
        credential: baseCredential,
        config: baseConfig,
        entity: quarantineEntity,
        columns: ["run_id", "dest_table", "step_id", "function", "input_value", "source_row"],
        rows: [[runId, "sales.orders", "step1", "parse_date", "bad-date", "{}"]],
        upsertKeys: ["run_id"],
        context: { connectionId: baseCredential.connectionId, grantId: baseGrantId, runId, entity, columns, mode: "upsert", stagingEntity: null, quarantineEntity, issuedAt, signature },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(execMock).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO `nia`.`nia_quarantine`"), expect.anything());
  });
});

describe("connector-mysql /stage (route-level)", () => {
  const entity = { namespace: "sales", name: "orders" };
  const columns = ["id", "total"];
  const stagingEntity = { namespace: "staging", name: "nia_stg_abc123" };
  const runId = "33333333-3333-3333-3333-333333333333";

  function signedContext(app: { signWriteContext: (typeof import("./writeSignature.js"))["signWriteContext"] }, overrides: Record<string, unknown> = {}) {
    const issuedAt = Date.now();
    const base = { connectionId: baseCredential.connectionId, grantId: baseGrantId, runId, entity, columns, mode: "upsert" as const, stagingEntity, quarantineEntity: null, issuedAt };
    const payload = { ...base, ...overrides };
    const signature = app.signWriteContext(payload, "a".repeat(32));
    return { ...payload, signature };
  }

  function stagePayload(app: { signWriteContext: (typeof import("./writeSignature.js"))["signWriteContext"] }, op: "create" | "apply" | "drop", overrides: Record<string, unknown> = {}) {
    const context = signedContext(app);
    return {
      credential: baseCredential,
      config: baseConfig,
      op,
      entity,
      stagingEntity,
      quarantineEntity: null,
      runId,
      mode: "upsert" as const,
      upsertKeys: ["id"],
      assertions: [],
      context,
      ...overrides,
    };
  }

  it("creates the staging database+table via fixed DDL templates for a valid, signed create request", async () => {
    const { app, signWriteContext } = await freshApp();
    execMock.mockResolvedValue([{}, undefined]);
    const res = await app.inject({ method: "POST", url: "/stage", payload: stagePayload({ signWriteContext }, "create") });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ op: "create", ok: true });
    expect(execMock).toHaveBeenCalledWith("CREATE DATABASE IF NOT EXISTS `nia`", undefined);
    expect(execMock).toHaveBeenCalledWith(expect.stringContaining("CREATE TABLE IF NOT EXISTS `nia`.`nia_stg_abc123` LIKE `sales`.`orders`"), undefined);
  });

  it("rejects a create/drop/apply whose stagingEntity doesn't match the signed context's stagingEntity", async () => {
    const { app, signWriteContext } = await freshApp();
    const res = await app.inject({
      method: "POST",
      url: "/stage",
      payload: stagePayload({ signWriteContext }, "drop", { stagingEntity: { namespace: "staging", name: "nia_stg_someone_elses_table" } }),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().message).toMatch(/stagingEntity does not match the signed context's stagingEntity/);
    expect(execMock).not.toHaveBeenCalled();
  });

  it("rejects a request whose runId doesn't match the signed context's runId", async () => {
    const { app, signWriteContext } = await freshApp();
    const res = await app.inject({
      method: "POST",
      url: "/stage",
      payload: stagePayload({ signWriteContext }, "drop", { runId: "44444444-4444-4444-4444-444444444444" }),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().message).toMatch(/signed context runId does not match the request runId/);
    expect(execMock).not.toHaveBeenCalled();
  });

  it("rejects a request whose quarantineEntity doesn't match the signed context's quarantineEntity", async () => {
    const { app, signWriteContext } = await freshApp();
    const res = await app.inject({
      method: "POST",
      url: "/stage",
      payload: stagePayload({ signWriteContext }, "drop", { quarantineEntity: { namespace: "nia", name: "nia_quarantine" } }),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().message).toMatch(/request quarantineEntity does not match the signed context's quarantineEntity/);
    expect(execMock).not.toHaveBeenCalled();
  });

  it("rejects an apply whose entity doesn't match the signed context's entity", async () => {
    const { app, signWriteContext } = await freshApp();
    const res = await app.inject({
      method: "POST",
      url: "/stage",
      payload: stagePayload({ signWriteContext }, "apply", { entity: { namespace: "sales", name: "customers" } }),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().message).toMatch(/request entity does not match the signed context's entity/);
    expect(execMock).not.toHaveBeenCalled();
  });

  it("drops the staging table via fixed DDL for a valid, signed drop request", async () => {
    const { app, signWriteContext } = await freshApp();
    execMock.mockResolvedValue([{}, undefined]);
    const res = await app.inject({ method: "POST", url: "/stage", payload: stagePayload({ signWriteContext }, "drop") });
    expect(res.statusCode).toBe(200);
    expect(execMock).toHaveBeenCalledWith("DROP TABLE IF EXISTS `nia`.`nia_stg_abc123`", undefined);
  });

  it("applies staging to the destination via UPSERT when assertions pass, inside one transaction", async () => {
    const { app, signWriteContext } = await freshApp();
    execMock.mockImplementation(async (sql: string) => {
      if (sql.includes("COUNT(*)")) return [[{ n: 0 }], undefined];
      return [{ affectedRows: 2 }, undefined];
    });
    const res = await app.inject({
      method: "POST",
      url: "/stage",
      payload: stagePayload({ signWriteContext }, "apply", { assertions: [{ kind: "noNullKeys", columns: ["id"] }] }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ op: "apply", ok: true, applied: 2 });
    expect(execMock).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO `sales`.`orders`"), undefined);
    expect(beginTransactionMock).toHaveBeenCalledOnce();
    expect(commitMock).toHaveBeenCalledOnce();
  });

  it("rolls back and reports ok:false when a pre-apply assertion fails, without touching the destination", async () => {
    const { app, signWriteContext } = await freshApp();
    execMock.mockImplementation(async (sql: string) => {
      if (sql.includes("COUNT(*)")) return [[{ n: 3 }], undefined];
      return [{ affectedRows: 0 }, undefined];
    });
    const res = await app.inject({
      method: "POST",
      url: "/stage",
      payload: stagePayload({ signWriteContext }, "apply", { assertions: [{ kind: "noNullKeys", columns: ["id"] }] }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.assertionResults[0]).toMatchObject({ ok: false });
    expect(execMock).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO"), expect.anything());
    expect(rollbackMock).toHaveBeenCalledOnce();
  });
});
