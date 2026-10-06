import { describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";

// Same fully-mocked-@nia/db convention as app.test.ts — no real socket, no
// real Postgres. Shared mockQuery lets each test script an exact sequence
// of rows for resolveAgentConnection's 3 reads + runAgentTask's insert/
// update, in call order.
const mockQuery = vi.fn();
vi.mock("@nia/db", () => ({
  createDbPool: () => ({}),
  withServiceRole: (_pool: unknown, fn: (db: { query: typeof mockQuery }) => unknown) => fn({ query: mockQuery }),
}));

// Slice T2 — readAheadCache.ts's module-level `new Redis(...)` needs a
// fake instead of a real server for these tests. Minimal in-memory
// getdel/set, same semantics as real Redis (GETDEL removes on read).
// The factory re-runs (fresh store) every time freshApps()'s
// vi.resetModules() forces a re-import, which is exactly the isolation
// each test wants.
vi.mock("ioredis", () => {
  class FakeRedis {
    private store = new Map<string, string>();
    async getdel(key: string): Promise<string | null> {
      const value = this.store.get(key) ?? null;
      this.store.delete(key);
      return value;
    }
    async set(key: string, value: string): Promise<"OK"> {
      this.store.set(key, value);
      return "OK";
    }
    async quit(): Promise<"OK"> {
      return "OK";
    }
  }
  return { Redis: FakeRedis };
});

const SECRET = "test-signing-secret";
process.env.WRITE_DISPATCH_SIGNING_SECRET = SECRET;

const CONNECTION_ID = "11111111-1111-1111-1111-111111111111";
const AGENT_ID = "22222222-2222-2222-2222-222222222222";
const ORG_ID = "33333333-3333-3333-3333-333333333333";
const TASK_ID = "44444444-4444-4444-4444-444444444444";
const OTHER_AGENT_ID = "55555555-5555-5555-5555-555555555555";

async function freshApps() {
  vi.resetModules();
  mockQuery.mockReset();
  // Importing both from the same vi.resetModules() cycle means they share
  // one taskBus.ts singleton module instance, exactly like the real
  // process — required for the "Allowed" test's cross-app handoff below.
  const { buildApp } = await import("./app.js");
  const { buildInternalApp } = await import("./internalApp.js");
  const { signReadContext } = await import("./writeSignature.js");
  return { buildApp, buildInternalApp, signReadContext };
}

function credentialFor(connectionId: string) {
  return { connectionId, credVersion: 0, vaultRef: "vault/path" };
}

/** Polls the shared mock until it has recorded `min` calls, then gives the
 * synchronous continuation after the last one (which registers taskBus's
 * result listener) a little real time to run — avoids racing a same-tick
 * HTTP call against microtask ordering. */
async function waitForCallCount(min: number, timeoutMs = 2000) {
  const start = Date.now();
  while (mockQuery.mock.calls.length < min) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${min} db calls`);
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise((r) => setTimeout(r, 15));
}

describe("agent-bridge internal listener — allowed", () => {
  it("an /introspect task is created, delivered via task-results, and resolves with the {entities} shape", async () => {
    const { buildApp, buildInternalApp, signReadContext } = await freshApps();
    const publicApp = buildApp();
    const internalApp = buildInternalApp();

    mockQuery.mockResolvedValueOnce({
      rows: [{ org_id: ORG_ID, owner_id: null, config: { agentId: AGENT_ID, agentConnectionId: "local-1" } }],
    }); // connection row
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: AGENT_ID, org_id: ORG_ID, owner_id: null, status: "active", last_check_in_at: new Date().toISOString() }],
    }); // agent row — active and online
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: 1 }] }); // agent still reports this local connection
    mockQuery.mockResolvedValueOnce({ rows: [{ id: TASK_ID }] }); // agent_tasks insert
    mockQuery.mockResolvedValueOnce({ rows: [{ id: TASK_ID }] }); // task-results UPDATE

    const issuedAt = Date.now();
    const signature = signReadContext({ route: "introspect", connectionId: CONNECTION_ID, queryPayload: null, issuedAt }, SECRET);

    const introspectPromise = internalApp.inject({
      method: "POST",
      url: "/introspect",
      payload: { credential: credentialFor(CONNECTION_ID), config: {}, context: { issuedAt, signature } },
    });

    // Simulated check-in delivery + the agent's dedicated task-results post
    // — the only path a result ever travels (plan point 1).
    await waitForCallCount(4);
    const taskResultResponse = await publicApp.inject({
      method: "POST",
      url: "/agent-api/task-results",
      headers: { authorization: "Bearer test-agent-key" },
      payload: {
        taskId: TASK_ID,
        status: "done",
        result: { entities: [{ namespace: "dbo", name: "Orders", fields: [{ name: "id", type: "int" }] }] },
      },
    });
    expect(taskResultResponse.statusCode).toBe(200);
    expect(taskResultResponse.json()).toEqual({ ok: true });

    const introspectResponse = await introspectPromise;
    expect(introspectResponse.statusCode).toBe(200);
    expect(introspectResponse.json()).toEqual({
      entities: [{ namespace: "dbo", name: "Orders", fields: [{ name: "id", type: "int" }] }],
    });
  });
});

describe("agent-bridge internal listener — refused", () => {
  it("rejects /test and /introspect with an invalid signature, and neither route exists on the public listener", async () => {
    const { buildApp, buildInternalApp } = await freshApps();
    const internalApp = buildInternalApp();
    const publicApp = buildApp();

    const badContext = { issuedAt: Date.now(), signature: "0".repeat(64) };
    const credential = credentialFor(CONNECTION_ID);

    const testRes = await internalApp.inject({ method: "POST", url: "/test", payload: { credential, config: {}, context: badContext } });
    expect(testRes.statusCode).toBe(401);

    const introspectRes = await internalApp.inject({
      method: "POST",
      url: "/introspect",
      payload: { credential, config: {}, context: badContext },
    });
    expect(introspectRes.statusCode).toBe(401);

    // Bad signature is refused before any connection/agent lookup — no DB
    // call ever happens on this path.
    expect(mockQuery).not.toHaveBeenCalled();

    const publicTestRes = await publicApp.inject({ method: "POST", url: "/test", payload: {} });
    expect(publicTestRes.statusCode).toBe(404);
    const publicIntrospectRes = await publicApp.inject({ method: "POST", url: "/introspect", payload: {} });
    expect(publicIntrospectRes.statusCode).toBe(404);
  });
});

describe("agent-bridge internal listener — guard", () => {
  it("a revoked agent fails /test immediately with no agent_tasks row created", async () => {
    const { buildInternalApp, signReadContext } = await freshApps();
    const internalApp = buildInternalApp();

    mockQuery.mockResolvedValueOnce({
      rows: [{ org_id: ORG_ID, owner_id: null, config: { agentId: AGENT_ID, agentConnectionId: "local-1" } }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: AGENT_ID, org_id: ORG_ID, owner_id: null, status: "revoked", last_check_in_at: new Date().toISOString() }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: 1 }] });

    const issuedAt = Date.now();
    const signature = signReadContext({ route: "test", connectionId: CONNECTION_ID, queryPayload: null, issuedAt }, SECRET);

    const res = await internalApp.inject({
      method: "POST",
      url: "/test",
      payload: { credential: credentialFor(CONNECTION_ID), config: {}, context: { issuedAt, signature } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, error: "agent was revoked" });
    // Exactly the 3 resolveAgentConnection reads — no agent_tasks insert.
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it("an offline agent (stale last_check_in_at) fails /introspect immediately with no agent_tasks row created", async () => {
    const { buildInternalApp, signReadContext } = await freshApps();
    const internalApp = buildInternalApp();

    mockQuery.mockResolvedValueOnce({
      rows: [{ org_id: ORG_ID, owner_id: null, config: { agentId: AGENT_ID, agentConnectionId: "local-1" } }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: AGENT_ID,
          org_id: ORG_ID,
          owner_id: null,
          status: "active",
          last_check_in_at: new Date(Date.now() - 200_000).toISOString(), // > 90s ONLINE_THRESHOLD_MS
        },
      ],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: 1 }] });

    const issuedAt = Date.now();
    const signature = signReadContext({ route: "introspect", connectionId: CONNECTION_ID, queryPayload: null, issuedAt }, SECRET);

    const res = await internalApp.inject({
      method: "POST",
      url: "/introspect",
      payload: { credential: credentialFor(CONNECTION_ID), config: {}, context: { issuedAt, signature } },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe("agent is offline");
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it("a task that never gets a result times out within its own per-kind budget, never past it", async () => {
    vi.useFakeTimers();
    try {
      const { buildInternalApp, signReadContext } = await freshApps();
      const internalApp = buildInternalApp();

      mockQuery.mockResolvedValueOnce({
        rows: [{ org_id: ORG_ID, owner_id: null, config: { agentId: AGENT_ID, agentConnectionId: "local-1" } }],
      });
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: AGENT_ID, org_id: ORG_ID, owner_id: null, status: "active", last_check_in_at: new Date().toISOString() }],
      });
      mockQuery.mockResolvedValueOnce({ rows: [{ ok: 1 }] });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: TASK_ID }] }); // agent_tasks insert
      mockQuery.mockResolvedValueOnce({ rows: [] }); // best-effort "mark failed on timeout" update

      const issuedAt = Date.now();
      const signature = signReadContext({ route: "test", connectionId: CONNECTION_ID, queryPayload: null, issuedAt }, SECRET);

      const resPromise = internalApp.inject({
        method: "POST",
        url: "/test",
        payload: { credential: credentialFor(CONNECTION_ID), config: {}, context: { issuedAt, signature } },
      });

      // Let the resolveAgentConnection + insert awaits run so the 8000ms
      // test_connection timer is actually registered before advancing it.
      await vi.advanceTimersByTimeAsync(0);
      // Cross the test_connection budget (8000ms, strictly < apps/api's
      // 15000ms caller timeout) without any real wall-clock wait.
      await vi.advanceTimersByTimeAsync(8_000);

      const res = await resPromise;
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: false, error: "agent did not respond in time" });
    } finally {
      vi.useRealTimers();
    }
  });
});

// Slice T2 — /execute's structured read-ahead. A literal query object,
// built with keys in StructuredQueryPayload's own schema declaration
// order (kind, table, columns, filter, cursor, limit) — zod's object
// parser rebuilds its output in that same shape order regardless of the
// input's key order, so signing over JSON.stringify(this literal) before
// the request and JSON.stringify(ExecuteRequest.parse(body).query) after
// it inside internalApp.ts produce identical strings only when the
// literal is already in schema order.
function structuredQueryFor(cursor: { column: string; value: string | number } | null) {
  return {
    kind: "structured" as const,
    table: "dbo.Orders",
    columns: ["id", "amount"],
    filter: [] as unknown[],
    cursor,
    limit: 500,
  };
}

describe("agent-bridge internal listener — /execute read-ahead (allowed)", () => {
  it("returns the rows the agent uploaded, and serves the next cursor from read-ahead with no new task", async () => {
    const { buildApp, buildInternalApp, signReadContext } = await freshApps();
    const { signatureKeyFor } = await import("./readAheadCache.js");
    const publicApp = buildApp();
    const internalApp = buildInternalApp();

    const firstQuery = structuredQueryFor(null);
    const signatureKey = signatureKeyFor(CONNECTION_ID, firstQuery.table, firstQuery.columns, firstQuery.filter as never, firstQuery.limit);

    // --- First /execute: cache miss, a read_batch task is created. ---
    mockQuery.mockResolvedValueOnce({ rows: [{ connector_id: "sqlserver-agent" }] }); // getConnectorId
    mockQuery.mockResolvedValueOnce({
      rows: [{ org_id: ORG_ID, owner_id: null, config: { agentId: AGENT_ID, agentConnectionId: "local-1" } }],
    }); // connection row
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: AGENT_ID, org_id: ORG_ID, owner_id: null, status: "active", last_check_in_at: new Date().toISOString() }],
    }); // agent row
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: 1 }] }); // agent still reports this local connection
    mockQuery.mockResolvedValueOnce({ rows: [] }); // agent_tasks insert (no `returning id` on this route)

    const issuedAt1 = Date.now();
    const signature1 = signReadContext(
      { route: "execute", connectionId: CONNECTION_ID, queryPayload: JSON.stringify(firstQuery), issuedAt: issuedAt1 },
      SECRET,
    );
    const execute1Promise = internalApp.inject({
      method: "POST",
      url: "/execute",
      payload: {
        credential: credentialFor(CONNECTION_ID),
        config: {},
        query: firstQuery,
        context: { issuedAt: issuedAt1, signature: signature1 },
      },
    });

    // Let /execute reach taskBus.awaitBatch before the agent "uploads".
    await waitForCallCount(5);

    // The agent uploads the first batch (what the held /execute is
    // waiting on) AND pre-emptively uploads the next batch too — "the
    // agent uploads each batch as it is read" (plan point 2), so by the
    // time the worker asks for the next cursor it's already sitting in
    // Redis.
    const firstBatch = {
      cursor: null,
      columns: [{ name: "id", type: "number" }, { name: "amount", type: "number" }],
      rows: [[1, 100], [2, 200]],
      nextCursor: { column: "id", value: 2 },
      isLast: false,
    };
    const secondBatch = {
      cursor: { column: "id", value: 2 },
      columns: [{ name: "id", type: "number" }, { name: "amount", type: "number" }],
      rows: [[3, 300]],
      nextCursor: null,
      isLast: true,
    };

    mockQuery.mockResolvedValueOnce({ rows: [{ id: AGENT_ID, created_by_user_id: "user-1" }] }); // resolveAgentFromKey
    mockQuery.mockResolvedValueOnce({ rows: [{ payload: { signatureKey } }] }); // read-batch ownership select
    const upload1 = await publicApp.inject({
      method: "POST",
      url: `/agent-api/read-batches/${TASK_ID}`,
      headers: { authorization: "Bearer test-agent-key", "content-type": "application/gzip" },
      payload: gzipSync(Buffer.from(JSON.stringify(firstBatch), "utf8")),
    });
    expect(upload1.statusCode).toBe(200);

    mockQuery.mockResolvedValueOnce({ rows: [{ id: AGENT_ID, created_by_user_id: "user-1" }] }); // resolveAgentFromKey
    mockQuery.mockResolvedValueOnce({ rows: [{ payload: { signatureKey } }] }); // read-batch ownership select
    const upload2 = await publicApp.inject({
      method: "POST",
      url: `/agent-api/read-batches/${TASK_ID}`,
      headers: { authorization: "Bearer test-agent-key", "content-type": "application/gzip" },
      payload: gzipSync(Buffer.from(JSON.stringify(secondBatch), "utf8")),
    });
    expect(upload2.statusCode).toBe(200);

    const execute1Res = await execute1Promise;
    expect(execute1Res.statusCode).toBe(200);
    const body1 = execute1Res.json();
    expect(body1.columns).toEqual(firstBatch.columns);
    expect(body1.rows).toEqual(firstBatch.rows);
    expect(body1.meta).toMatchObject({ connectionId: CONNECTION_ID, rowCount: 2, truncated: false });
    expect(typeof body1.meta.durationMs).toBe("number");

    // --- Second /execute: same query, cursor = the first batch's
    // nextCursor — must be served from the read-ahead batch already
    // uploaded above, with exactly ONE db call (getConnectorId) and no
    // agent_tasks insert. ---
    const callsBeforeSecond = mockQuery.mock.calls.length;
    const secondQuery = structuredQueryFor({ column: "id", value: 2 });
    mockQuery.mockResolvedValueOnce({ rows: [{ connector_id: "sqlserver-agent" }] }); // getConnectorId only

    const issuedAt2 = Date.now();
    const signature2 = signReadContext(
      { route: "execute", connectionId: CONNECTION_ID, queryPayload: JSON.stringify(secondQuery), issuedAt: issuedAt2 },
      SECRET,
    );
    const execute2Res = await internalApp.inject({
      method: "POST",
      url: "/execute",
      payload: {
        credential: credentialFor(CONNECTION_ID),
        config: {},
        query: secondQuery,
        context: { issuedAt: issuedAt2, signature: signature2 },
      },
    });

    expect(execute2Res.statusCode).toBe(200);
    const body2 = execute2Res.json();
    expect(body2.columns).toEqual(secondBatch.columns);
    expect(body2.rows).toEqual(secondBatch.rows);
    expect(body2.meta).toMatchObject({ connectionId: CONNECTION_ID, rowCount: 1, truncated: false });
    // Exactly the one getConnectorId call — no resolveAgentConnection, no insert.
    expect(mockQuery.mock.calls.length).toBe(callsBeforeSecond + 1);
  });
});

describe("agent-bridge internal listener — /execute read-ahead (refused)", () => {
  it("rejects an unsigned /execute, blocks another agent's upload to a task it doesn't own, and refuses an oversized upload with the plain cap message", async () => {
    const { buildApp, buildInternalApp } = await freshApps();
    const publicApp = buildApp();
    const internalApp = buildInternalApp();

    // (a) Unsigned /execute is rejected before any DB call.
    const query = structuredQueryFor(null);
    const badContext = { issuedAt: Date.now(), signature: "0".repeat(64) };
    const executeRes = await internalApp.inject({
      method: "POST",
      url: "/execute",
      payload: { credential: credentialFor(CONNECTION_ID), config: {}, query, context: badContext },
    });
    expect(executeRes.statusCode).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();

    // (b) Another agent's (valid, non-revoked) key cannot upload to a
    // task it doesn't own — resolveAgentFromKey succeeds for that other
    // agent, but the ownership select (filtered by that same agent_id)
    // finds nothing.
    mockQuery.mockResolvedValueOnce({ rows: [{ id: OTHER_AGENT_ID, created_by_user_id: "user-2" }] }); // resolveAgentFromKey
    mockQuery.mockResolvedValueOnce({ rows: [] }); // ownership select — no match for this agent
    const batch = {
      cursor: null,
      columns: [{ name: "id", type: "number" }],
      rows: [[1]],
      nextCursor: null,
      isLast: true,
    };
    const otherAgentUpload = await publicApp.inject({
      method: "POST",
      url: `/agent-api/read-batches/${TASK_ID}`,
      headers: { authorization: "Bearer other-agent-key", "content-type": "application/gzip" },
      payload: gzipSync(Buffer.from(JSON.stringify(batch), "utf8")),
    });
    expect(otherAgentUpload.statusCode).toBe(404);
    expect(otherAgentUpload.json().message).toBe("task not found, not yours, or already resolved");

    // (c) A batch above the 20 MB cap fails with the plain message —
    // caught by the route's own Content-Length/body-size check, before
    // ever reaching gunzip or the ownership select.
    mockQuery.mockResolvedValueOnce({ rows: [{ id: AGENT_ID, created_by_user_id: "user-1" }] }); // resolveAgentFromKey
    const oversized = Buffer.alloc(20 * 1024 * 1024 + 1);
    const oversizedUpload = await publicApp.inject({
      method: "POST",
      url: `/agent-api/read-batches/${TASK_ID}`,
      headers: { authorization: "Bearer test-agent-key", "content-type": "application/gzip" },
      payload: oversized,
    });
    expect(oversizedUpload.statusCode).toBe(413);
    expect(oversizedUpload.json().message).toBe("batch exceeds the 20 MB upload cap — select fewer columns and try again");
  });
});
