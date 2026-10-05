import { describe, expect, it, vi } from "vitest";

// Same fully-mocked-@nia/db convention as app.test.ts — no real socket, no
// real Postgres. Shared mockQuery lets each test script an exact sequence
// of rows for resolveAgentConnection's 3 reads + runAgentTask's insert/
// update, in call order.
const mockQuery = vi.fn();
vi.mock("@nia/db", () => ({
  createDbPool: () => ({}),
  withServiceRole: (_pool: unknown, fn: (db: { query: typeof mockQuery }) => unknown) => fn({ query: mockQuery }),
}));

const SECRET = "test-signing-secret";
process.env.WRITE_DISPATCH_SIGNING_SECRET = SECRET;

const CONNECTION_ID = "11111111-1111-1111-1111-111111111111";
const AGENT_ID = "22222222-2222-2222-2222-222222222222";
const ORG_ID = "33333333-3333-3333-3333-333333333333";
const TASK_ID = "44444444-4444-4444-4444-444444444444";

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
