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
// Records BEGIN/COMMIT/ROLLBACK/SET LOCAL calls so tests can assert on
// transaction control flow directly (execMock only sees the "real" data
// queries — see the comment above).
const controlMock = vi.fn();

function makeClient() {
  return {
    query: vi.fn(async (q: string | { text: string; values?: unknown[] }) => {
      const text = typeof q === "string" ? q : q.text;
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || /^SET LOCAL/.test(text)) {
        controlMock(text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" ? text : "SET LOCAL");
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
  controlMock.mockReset();
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

  const stagingFields = { runId: null, mode: "upsert" as const, stagingEntity: null, quarantineEntity: null, grantNamespace: entity.namespace };

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
    execMock.mockResolvedValue({ rows: [], rowCount: 1 });

    const res = await app.inject({ method: "POST", url: "/write", payload: validPayload({ signWriteContext }) });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ written: 1 });
    expect(execMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('INSERT INTO "sales"."orders"'), values: [1, 100] }),
    );
    expect(verifyActiveWriteGrantMock).toHaveBeenCalledWith(baseGrantId, baseCredential.connectionId, "sales");
  });

  it("JSON.stringify's an object/array value bound for a JSON-typed destination column, after looking up its type", async () => {
    const { app, signWriteContext } = await freshApp();
    // queryMock is the direct pool.query call used for the destination-
    // column-type lookup (rowsNeedJsonCoercion sees an object value in the
    // batch); execMock is the real data write, issued separately via
    // executeWithStatementTimeout's checked-out client.
    queryMock.mockResolvedValueOnce({
      rows: [
        { column_name: "id", data_type: "integer" },
        { column_name: "payload", data_type: "jsonb" },
      ],
    });
    execMock.mockResolvedValue({ rows: [], rowCount: 1 });

    const columns = ["id", "payload"];
    const issuedAt = Date.now();
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
    expect(execMock).toHaveBeenCalledWith(
      expect.objectContaining({ values: [1, JSON.stringify({ a: 1, b: [2, 3] })] }),
    );
  });

  it("refuses with a clear error when an object/array value targets a non-JSON destination column, without writing anything", async () => {
    const { app, signWriteContext } = await freshApp();
    queryMock.mockResolvedValueOnce({
      rows: [
        { column_name: "id", data_type: "integer" },
        { column_name: "total", data_type: "numeric" },
      ],
    });

    const columns = ["id", "total"];
    const issuedAt = Date.now();
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
    expect(execMock).not.toHaveBeenCalled();
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
      { connectionId: otherConnectionId, grantId: baseGrantId, entity, columns, issuedAt, ...stagingFields },
      "a".repeat(32),
    );
    const res = await app.inject({
      method: "POST",
      url: "/write",
      payload: validPayload({ signWriteContext }, {
        context: { connectionId: otherConnectionId, grantId: baseGrantId, entity, columns, issuedAt, signature, ...stagingFields },
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
    expect(execMock).not.toHaveBeenCalled();
  });

  it("writes a quarantine row (entity == context.quarantineEntity) via the fixed quarantine-table INSERT, not the upsert path", async () => {
    const { app, signWriteContext } = await freshApp();
    execMock.mockResolvedValue({ rows: [], rowCount: 1 });
    const quarantineEntity = { namespace: "nia", name: "nia_quarantine" };
    const runId = "33333333-3333-3333-3333-333333333333";
    const issuedAt = Date.now();
    const signature = signWriteContext(
      { connectionId: baseCredential.connectionId, grantId: baseGrantId, runId, entity, columns, mode: "upsert", stagingEntity: null, quarantineEntity, issuedAt, grantNamespace: entity.namespace },
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
        context: { connectionId: baseCredential.connectionId, grantId: baseGrantId, runId, entity, columns, mode: "upsert", stagingEntity: null, quarantineEntity, issuedAt, signature, grantNamespace: entity.namespace },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(execMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('INSERT INTO "nia"."nia_quarantine"') }),
    );
  });
});

describe("connector-supabase /preflight (route-level)", () => {
  const entity = { namespace: "sales", name: "orders" };

  // Bug fix: Postgres checks the CREATE privilege *before* evaluating
  // `IF NOT EXISTS`, so unconditionally issuing `CREATE SCHEMA IF NOT
  // EXISTS "nia"` failed with "permission denied for database" for a role
  // that only ever holds schema-scoped CREATE on "nia" (by design), even
  // once "nia" already exists. The check must query pg_namespace and skip
  // the CREATE SCHEMA attempt entirely when it does.
  it("create-schema-nia passes by querying pg_namespace, without ever attempting CREATE SCHEMA, when \"nia\" already exists", async () => {
    const { app } = await freshApp();
    queryMock.mockImplementation(async (q: { text?: string } | string) => {
      const text = typeof q === "string" ? q : q.text ?? "";
      if (text.includes("pg_namespace WHERE nspname = 'nia'")) return { rows: [{ "?column?": 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const res = await app.inject({
      method: "POST",
      url: "/preflight",
      payload: { credential: baseCredential, config: baseConfig, entity, upsertKeys: ["id"] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { checks: Array<{ name: string; ok: boolean }> };
    expect(body.checks).toContainEqual({ name: "create-schema-nia", ok: true });
    expect(queryMock).not.toHaveBeenCalledWith('CREATE SCHEMA IF NOT EXISTS "nia"');
  });
});

describe("connector-supabase /stage (route-level)", () => {
  const entity = { namespace: "sales", name: "orders" };
  const columns = ["id", "total"];
  const stagingEntity = { namespace: "staging", name: "nia_stg_abc123" };
  const runId = "33333333-3333-3333-3333-333333333333";

  function signedContext(app: { signWriteContext: (typeof import("./writeSignature.js"))["signWriteContext"] }, overrides: Record<string, unknown> = {}) {
    const issuedAt = Date.now();
    const base = { connectionId: baseCredential.connectionId, grantId: baseGrantId, runId, entity, columns, mode: "upsert" as const, stagingEntity, quarantineEntity: null, issuedAt, grantNamespace: entity.namespace };
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

  it("creates the staging schema+table via fixed DDL templates for a valid, signed create request", async () => {
    const { app, signWriteContext } = await freshApp();
    execMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await app.inject({ method: "POST", url: "/stage", payload: stagePayload({ signWriteContext }, "create") });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ op: "create", ok: true });
    expect(execMock).toHaveBeenCalledWith('CREATE SCHEMA IF NOT EXISTS "nia"');
    expect(execMock).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS "nia"."nia_stg_abc123" (LIKE "sales"."orders"'));
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
    execMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await app.inject({ method: "POST", url: "/stage", payload: stagePayload({ signWriteContext }, "drop") });
    expect(res.statusCode).toBe(200);
    expect(execMock).toHaveBeenCalledWith('DROP TABLE IF EXISTS "nia"."nia_stg_abc123"');
  });

  it("applies staging to the destination via UPSERT when assertions pass, inside one transaction", async () => {
    const { app, signWriteContext } = await freshApp();
    execMock.mockImplementation(async (q: { text?: string } | string) => {
      const text = typeof q === "string" ? q : q.text;
      if (text?.includes("COUNT(*)")) return { rows: [{ n: 0 }] };
      return { rows: [], rowCount: 2 };
    });
    const res = await app.inject({
      method: "POST",
      url: "/stage",
      payload: stagePayload({ signWriteContext }, "apply", { assertions: [{ kind: "noNullKeys", columns: ["id"] }] }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ op: "apply", ok: true, applied: 2 });
    expect(execMock).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO "sales"."orders"'));
  });

  it("rolls back and reports ok:false when a pre-apply assertion fails, without touching the destination", async () => {
    const { app, signWriteContext } = await freshApp();
    execMock.mockImplementation(async (q: { text?: string } | string) => {
      const text = typeof q === "string" ? q : q.text;
      if (text?.includes("COUNT(*)")) return { rows: [{ n: 3 }] };
      return { rows: [], rowCount: 0 };
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
    expect(execMock).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO"));
  });

  it("rolls back and rethrows (no ok:false response) when the apply DML itself fails mid-transaction, not just when an assertion fails", async () => {
    const { app, signWriteContext } = await freshApp();
    execMock.mockImplementation(async (q: { text?: string } | string) => {
      const text = typeof q === "string" ? q : q.text;
      if (text?.includes("COUNT(*)")) return { rows: [{ n: 0 }] };
      if (text?.includes("INSERT INTO")) throw new Error("duplicate key value violates unique constraint");
      return { rows: [], rowCount: 0 };
    });
    const res = await app.inject({
      method: "POST",
      url: "/stage",
      payload: stagePayload({ signWriteContext }, "apply", { assertions: [{ kind: "noNullKeys", columns: ["id"] }] }),
    });
    // Not a 200 op:"apply",ok:false response (that shape is reserved for
    // assertion failures) — a mid-transaction DML failure is a hard error,
    // matching the plan's "fails loudly" bar.
    expect(res.statusCode).toBe(500);
    expect(res.json().message).toMatch(/duplicate key value violates unique constraint/);
    expect(controlMock).toHaveBeenCalledWith("ROLLBACK");
    expect(controlMock).not.toHaveBeenCalledWith("COMMIT");
  });
});
