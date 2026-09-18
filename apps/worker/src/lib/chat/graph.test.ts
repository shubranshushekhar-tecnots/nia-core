import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ConnectorManifest, IntrospectResponse, TabularResult } from "@nia/schemas";
import type { ResolvedConnection } from "../resolveConnection.js";
import type { ChatStreamEvent } from "@nia/schemas";

/**
 * Mocked-pipeline tests — prove the graph's wiring/routing/structural
 * guarantees deterministically. These do NOT prove the thing works against
 * real infra/models; that's scripts/chat-smoke.ts's job (see its header).
 *
 * Mocking strategy mirrors dispatch.test.ts: mock only the true I/O edges
 * (resolveConnection, connectorClient, executionAudit, the LLM gateway,
 * and the Redis publisher) so dispatch.ts's real guardrail enforcement
 * (@nia/guardrails) actually runs — a destructive generated query is
 * proven to be rejected by the REAL validator, not by a mocked stand-in.
 */

const resolveConnectionMock = vi.fn();
vi.mock("../resolveConnection.js", () => ({ resolveConnection: (...args: unknown[]) => resolveConnectionMock(...args) }));

const sendToConnectorMock = vi.fn();
const sendIntrospectRequestMock = vi.fn();
vi.mock("../connectorClient.js", () => ({
  sendToConnector: (...args: unknown[]) => sendToConnectorMock(...args),
  sendIntrospectRequest: (...args: unknown[]) => sendIntrospectRequestMock(...args),
}));

const logExecutionAuditMock = vi.fn();
vi.mock("../executionAudit.js", () => ({ logExecutionAudit: (...args: unknown[]) => logExecutionAuditMock(...args) }));

const completeMock = vi.fn();
const streamCompleteMock = vi.fn();
vi.mock("../llm/gatewayClient.js", () => ({
  complete: (...args: unknown[]) => completeMock(...args),
  streamComplete: (...args: unknown[]) => streamCompleteMock(...args),
}));

const publishChatEventMock = vi.fn();
vi.mock("./publish.js", () => ({
  publishChatEvent: (...args: unknown[]) => publishChatEventMock(...args),
  channelFor: (scope: unknown, jobId: string) => `chat:events:${JSON.stringify(scope)}:${jobId}`,
}));

const { buildChatGraph } = await import("./graph.js");

const ACTOR_ID = "33333333-3333-3333-3333-333333333333";
const SCOPE = { orgId: "org-1" };

const manifest: ConnectorManifest = {
  id: "mysql",
  name: "MySQL",
  version: "1.0.0",
  category: "database",
  auth: { method: "credentials" },
  configSchema: [],
  operations: ["read"],
  capabilities: ["queryable"],
  service: { host: "connector-mysql", port: 4010 },
};

const schema: IntrospectResponse = {
  entities: [
    {
      namespace: "public",
      name: "employees",
      fields: [
        { name: "name", type: "text" },
        { name: "salary", type: "numeric" },
      ],
      primaryKey: null,
    },
  ],
};

function makeConnection(connectionId: string): ResolvedConnection {
  return {
    id: connectionId,
    connectorId: "mysql",
    handle: "@mysql-sales",
    config: { host: "localhost", port: 3306, database: "sales" },
    ownerUserId: "44444444-4444-4444-4444-444444444444",
    credential: { connectionId, credVersion: 1, vaultRef: "vault-ref-1" },
    manifest,
  };
}

function tabularResult(connectionId: string, opts: { truncated?: boolean; rowCount?: number } = {}): TabularResult {
  const rowCount = opts.rowCount ?? 1;
  return {
    columns: [
      { name: "name", type: "string" },
      { name: "salary", type: "number" },
    ],
    rows: Array.from({ length: rowCount }, (_, i) => [`Employee ${i}`, 100000 - i]),
    meta: {
      executedQuery: "SELECT name, salary FROM employees ORDER BY salary DESC LIMIT 1",
      connectionId,
      durationMs: 5,
      rowCount,
      truncated: opts.truncated ?? false,
    },
  };
}

function initialState(connectionId: string) {
  return {
    jobId: `job-${connectionId}`,
    userId: ACTOR_ID,
    conversationId: `conv-${connectionId}`,
    connectionId,
    scope: SCOPE,
    rawMessage: "who has the highest salary?",
  };
}

function eventsOfType(type: ChatStreamEvent["type"]) {
  return publishChatEventMock.mock.calls
    .map((call) => call[2] as ChatStreamEvent)
    .filter((event) => event.type === type);
}

describe("chat graph", () => {
  beforeEach(() => {
    resolveConnectionMock.mockReset();
    sendToConnectorMock.mockReset();
    sendIntrospectRequestMock.mockReset();
    logExecutionAuditMock.mockReset();
    logExecutionAuditMock.mockResolvedValue(undefined);
    completeMock.mockReset();
    streamCompleteMock.mockReset();
    publishChatEventMock.mockReset();
    publishChatEventMock.mockResolvedValue(undefined);
  });

  it("never executes a destructive generated query — the real guardrail rejects it both attempts, then fails cleanly", async () => {
    const connectionId = "11111111-1111-1111-1111-111111111111";
    resolveConnectionMock.mockResolvedValue({ ok: true, value: makeConnection(connectionId) });
    sendIntrospectRequestMock.mockResolvedValue({ ok: true, value: schema });

    // First attempt: outright destructive. Second attempt (fed the guardrail's
    // rejection reason): still not a SELECT. Both must be rejected by the
    // REAL @nia/guardrails validator (not mocked) before ever reaching
    // sendToConnector.
    completeMock
      .mockResolvedValueOnce(JSON.stringify({ sql: "DROP TABLE employees" }))
      .mockResolvedValueOnce(JSON.stringify({ sql: "DELETE FROM employees WHERE 1=1" }));

    const graph = buildChatGraph();
    const finalState = await graph.invoke(initialState(connectionId));

    expect(sendToConnectorMock).not.toHaveBeenCalled();
    expect(completeMock).toHaveBeenCalledTimes(2);
    expect(finalState.error).toMatch(/guardrail rejected the query twice/i);

    const errorEvents = eventsOfType("error");
    expect(errorEvents).toHaveLength(1);
  });

  it("retries query generation exactly once on guardrail rejection, then succeeds", async () => {
    const connectionId = "22222222-2222-2222-2222-222222222222";
    resolveConnectionMock.mockResolvedValue({ ok: true, value: makeConnection(connectionId) });
    sendIntrospectRequestMock.mockResolvedValue({ ok: true, value: schema });
    completeMock
      .mockResolvedValueOnce(JSON.stringify({ sql: "DROP TABLE employees" }))
      .mockResolvedValueOnce(JSON.stringify({ sql: "SELECT name, salary FROM employees ORDER BY salary DESC LIMIT 1" }))
      // faithfulness check after buildAnswer
      .mockResolvedValueOnce("OK");
    sendToConnectorMock.mockResolvedValue({ ok: true, value: tabularResult(connectionId) });
    streamCompleteMock.mockImplementation(async (_messages, onToken) => {
      await onToken("Employee 0 has the highest salary.");
      return "Employee 0 has the highest salary.";
    });

    const graph = buildChatGraph();
    const finalState = await graph.invoke(initialState(connectionId));

    expect(sendToConnectorMock).toHaveBeenCalledTimes(1);
    expect(finalState.error).toBeUndefined();
    expect(finalState.faithful).toBe(true);

    const doneEvents = eventsOfType("done");
    expect(doneEvents).toEqual([{ type: "done", faithful: true }]);
  });

  it("retries the answer exactly once on a faithfulness conflict, and surfaces faithful:false in the done event if still conflicting (not shipped silently)", async () => {
    const connectionId = "55555555-5555-5555-5555-555555555555";
    resolveConnectionMock.mockResolvedValue({ ok: true, value: makeConnection(connectionId) });
    sendIntrospectRequestMock.mockResolvedValue({ ok: true, value: schema });
    completeMock
      .mockResolvedValueOnce(JSON.stringify({ sql: "SELECT name, salary FROM employees ORDER BY salary DESC LIMIT 1" }))
      // faithfulness verdict #1: conflict -> retry
      .mockResolvedValueOnce("CONFLICT: answer mentions a person not in the rows")
      // faithfulness verdict #2: still conflicts -> ship anyway, but flagged
      .mockResolvedValueOnce("CONFLICT: still not supported by the rows");
    sendToConnectorMock.mockResolvedValue({ ok: true, value: tabularResult(connectionId) });
    streamCompleteMock.mockImplementation(async (_messages, onToken) => {
      await onToken("Someone has the highest salary.");
      return "Someone has the highest salary.";
    });

    const graph = buildChatGraph();
    const finalState = await graph.invoke(initialState(connectionId));

    // buildAnswer ran twice: once initially, once retried after the first conflict.
    expect(streamCompleteMock).toHaveBeenCalledTimes(2);
    expect(finalState.faithful).toBe(false);
    expect(finalState.error).toBeUndefined();

    const doneEvents = eventsOfType("done");
    expect(doneEvents).toEqual([{ type: "done", faithful: false }]);
  });

  it("prepends the truncation caveat in code — present in the token stream and citation regardless of the model's own output", async () => {
    const connectionId = "77777777-7777-7777-7777-777777777777";
    resolveConnectionMock.mockResolvedValue({ ok: true, value: makeConnection(connectionId) });
    sendIntrospectRequestMock.mockResolvedValue({ ok: true, value: schema });
    completeMock
      .mockResolvedValueOnce(JSON.stringify({ sql: "SELECT name, salary FROM employees ORDER BY salary DESC LIMIT 1000" }))
      .mockResolvedValueOnce("OK");
    // Truncated result — the model's own text deliberately says nothing about it,
    // proving the caveat isn't dependent on the model choosing to mention it.
    sendToConnectorMock.mockResolvedValue({ ok: true, value: tabularResult(connectionId, { truncated: true, rowCount: 1000 }) });
    streamCompleteMock.mockImplementation(async (_messages, onToken) => {
      await onToken("Employee 0 has the highest salary.");
      return "Employee 0 has the highest salary.";
    });

    const graph = buildChatGraph();
    await graph.invoke(initialState(connectionId));

    const tokenEvents = eventsOfType("token") as Extract<ChatStreamEvent, { type: "token" }>[];
    expect(tokenEvents[0]?.text).toMatch(/truncated/i);
    // The code-inserted caveat must come before any model-generated token.
    expect(tokenEvents[0]?.text).not.toContain("Employee 0 has the highest salary.");

    const citationEvents = eventsOfType("citation") as Extract<ChatStreamEvent, { type: "citation" }>[];
    expect(citationEvents).toHaveLength(1);
    expect(citationEvents[0]?.truncated).toBe(true);
  });
});
