import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ConnectorManifest, IntrospectResponse, TabularResult } from "@nia/schemas";
import type { ResolvedConnection } from "../../resolveConnection.js";
import type { ChatStreamEvent } from "@nia/schemas";

/**
 * Mocked-pipeline tests for the multi-source graph — mirrors ../graph.test.ts's
 * mocking strategy exactly (mock only the true I/O edges: resolveConnection,
 * connectorClient, executionAudit, the LLM gateway, and the Redis publisher),
 * so dispatch.ts's real guardrail enforcement (@nia/guardrails) and reduce.ts's
 * real arithmetic both actually run — not stand-ins.
 *
 * completeMock is shared across every concurrent per-source pipeline AND the
 * top-level planReduction/faithfulnessMulti steps, so (unlike ../graph.test.ts,
 * which can rely on call-order with mockResolvedValueOnce) it dispatches on the
 * CONTENT of the system prompt instead — order across fanned-out sources is not
 * guaranteed under concurrency.
 */

const resolveConnectionMock = vi.fn();
vi.mock("../../resolveConnection.js", () => ({ resolveConnection: (...args: unknown[]) => resolveConnectionMock(...args) }));

const sendToConnectorMock = vi.fn();
const sendIntrospectRequestMock = vi.fn();
vi.mock("../../connectorClient.js", () => ({
  sendToConnector: (...args: unknown[]) => sendToConnectorMock(...args),
  sendIntrospectRequest: (...args: unknown[]) => sendIntrospectRequestMock(...args),
}));

const logExecutionAuditMock = vi.fn();
vi.mock("../../executionAudit.js", () => ({ logExecutionAudit: (...args: unknown[]) => logExecutionAuditMock(...args) }));

const completeMock = vi.fn();
const streamCompleteMock = vi.fn();
vi.mock("../../llm/gatewayClient.js", () => ({
  complete: (...args: unknown[]) => completeMock(...args),
  streamComplete: (...args: unknown[]) => streamCompleteMock(...args),
}));

const publishChatEventMock = vi.fn();
vi.mock("../publish.js", () => ({
  publishChatEvent: (...args: unknown[]) => publishChatEventMock(...args),
  channelFor: (scope: unknown, jobId: string) => `chat:events:${JSON.stringify(scope)}:${jobId}`,
}));

const { buildMultiSourceGraph } = await import("./graph.js");

const SCOPE = { orgId: "org-1" };
const USER_ID = "44444444-4444-4444-4444-444444444444";

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
    },
  ],
};

function makeConnection(connectionId: string): ResolvedConnection {
  return {
    id: connectionId,
    connectorId: "mysql",
    handle: `@mysql-${connectionId}`,
    config: { host: "localhost", port: 3306, database: "sales" },
    ownerUserId: USER_ID,
    credential: { connectionId, credVersion: 1, vaultRef: "vault-ref-1" },
    manifest,
  };
}

function tabularResult(connectionId: string, salary: number, opts: { truncated?: boolean } = {}): TabularResult {
  return {
    columns: [
      { name: "name", type: "string" },
      { name: "salary", type: "number" },
    ],
    rows: [[`Employee ${connectionId}`, salary]],
    meta: {
      executedQuery: `SELECT name, salary FROM employees WHERE salary = (SELECT MAX(salary) FROM employees)`,
      connectionId,
      durationMs: 5,
      rowCount: 1,
      truncated: opts.truncated ?? false,
    },
  };
}

function initialState(connectionIds: string[], message = "who has the highest salary across these sources?") {
  return {
    jobId: `job-${connectionIds.join("-")}`,
    userId: USER_ID,
    conversationId: `conv-${connectionIds.join("-")}`,
    connectionIds,
    scope: SCOPE,
    rawMessage: message,
    standaloneMessage: message,
  };
}

function eventsOfType(type: ChatStreamEvent["type"]) {
  return publishChatEventMock.mock.calls.map((call) => call[2] as ChatStreamEvent).filter((event) => event.type === type);
}

/** Dispatches completeMock's response by inspecting the system prompt content — safe under the concurrent fan-out, where call order isn't guaranteed. */
function mockCompleteRouting(opts: {
  plan?: { supported: true; operation: "max" | "min" | "sum" | "count"; targetField: string; targetDescription: string } | { supported: false; reason: string };
  faithfulVerdict?: string;
}) {
  const plan = opts.plan ?? { supported: true, operation: "max" as const, targetField: "salary", targetDescription: "the highest salary" };
  completeMock.mockImplementation(async (messages: { role: string; content: string }[]) => {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    if (system.includes("You classify a question")) return JSON.stringify(plan);
    if (system.includes("translate a user's question into a single read-only MySQL query")) {
      return JSON.stringify({ sql: "SELECT name, salary FROM employees WHERE salary = (SELECT MAX(salary) FROM employees)", params: [] });
    }
    if (system.includes("grade whether an answer")) return opts.faithfulVerdict ?? "OK";
    throw new Error(`mockCompleteRouting: unrecognized system prompt: ${system.slice(0, 80)}`);
  });
}

describe("multi-source chat graph", () => {
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

    sendIntrospectRequestMock.mockResolvedValue({ ok: true, value: schema });
    resolveConnectionMock.mockImplementation(async (connectionId: string) => ({ ok: true, value: makeConnection(connectionId) }));
    streamCompleteMock.mockImplementation(async (_messages: unknown, onToken: (t: string) => Promise<void>) => {
      await onToken("Employee B has the highest salary.");
      return "Employee B has the highest salary.";
    });
  });

  it("fans out to 2 sources, reduces to the true max, and cites both sources", async () => {
    mockCompleteRouting({});
    sendToConnectorMock.mockImplementation(async (_manifest, credential) => {
      const salary = credential.connectionId === "source-a" ? 100000 : 200000;
      return { ok: true, value: tabularResult(credential.connectionId, salary) };
    });

    const graph = buildMultiSourceGraph();
    const finalState = await graph.invoke(initialState(["source-a", "source-b"]));

    expect(finalState.error).toBeUndefined();
    expect(finalState.refusal).toBeUndefined();
    expect(finalState.conflictMessage).toBeUndefined();
    expect(finalState.reduceOutcome).toMatchObject({ ok: true, value: 200000 });
    expect(finalState.faithful).toBe(true);

    const citationEvents = eventsOfType("citation") as Extract<ChatStreamEvent, { type: "citation" }>[];
    expect(citationEvents).toHaveLength(2);
    expect(citationEvents.map((c) => c.connectionId).sort()).toEqual(["source-a", "source-b"]);

    const doneEvents = eventsOfType("done");
    expect(doneEvents).toEqual([{ type: "done", faithful: true, truncated: false }]);
  });

  it("refuses an unsupported operation before any source is touched", async () => {
    mockCompleteRouting({ plan: { supported: false, reason: "asks for a list, not a reduction" } });

    const graph = buildMultiSourceGraph();
    const finalState = await graph.invoke(initialState(["source-a", "source-b"], "list all employees"));

    expect(finalState.refusal).toEqual({ kind: "unsupported-operation", message: "asks for a list, not a reduction" });
    expect(resolveConnectionMock).not.toHaveBeenCalled();
    expect(sendToConnectorMock).not.toHaveBeenCalled();

    const refusedEvents = eventsOfType("refused");
    expect(refusedEvents).toEqual([{ type: "refused", kind: "unsupported-operation", message: "asks for a list, not a reduction" }]);
    expect(eventsOfType("done")).toHaveLength(0);
  });

  it("refuses as a partial-failure when one source fails, without answering from the rest", async () => {
    mockCompleteRouting({});
    resolveConnectionMock.mockImplementation(async (connectionId: string) =>
      connectionId === "source-bad"
        ? { ok: false, error: { kind: "connection-not-found", message: "connection source-bad not found" } }
        : { ok: true, value: makeConnection(connectionId) },
    );
    sendToConnectorMock.mockResolvedValue({ ok: true, value: tabularResult("source-a", 100000) });

    const graph = buildMultiSourceGraph();
    const finalState = await graph.invoke(initialState(["source-a", "source-bad"]));

    expect(finalState.refusal?.kind).toBe("partial-failure");
    expect(streamCompleteMock).not.toHaveBeenCalled();
    expect(eventsOfType("citation")).toHaveLength(0);
    expect(eventsOfType("done")).toHaveLength(0);

    const refusedEvents = eventsOfType("refused");
    expect(refusedEvents).toHaveLength(1);
    expect((refusedEvents[0] as Extract<ChatStreamEvent, { type: "refused" }>).kind).toBe("partial-failure");
  });

  it("surfaces a genuine tie as a terminal conflict event — no answer is generated", async () => {
    mockCompleteRouting({});
    // Both sources tie at 200000 — reduce.ts must report both as winners,
    // and the graph must stop at conflictNode rather than proceeding to
    // buildAnswerMulti/faithfulnessMulti/finalizeMulti.
    sendToConnectorMock.mockImplementation(async (_manifest, credential) => ({
      ok: true,
      value: tabularResult(credential.connectionId, 200000),
    }));

    const graph = buildMultiSourceGraph();
    const finalState = await graph.invoke(initialState(["source-a", "source-b"]));

    expect(finalState.refusal).toBeUndefined();
    expect(finalState.conflictMessage).toMatch(/tie/i);
    expect(streamCompleteMock).not.toHaveBeenCalled();

    const conflictEvents = eventsOfType("conflict");
    expect(conflictEvents).toHaveLength(1);
    expect(eventsOfType("done")).toHaveLength(0);
    expect(eventsOfType("citation")).toHaveLength(0);
  });

  it("refuses (never silently corrupts a total) when a source's result for sum/count is truncated", async () => {
    mockCompleteRouting({ plan: { supported: true, operation: "count", targetField: "id", targetDescription: "the total number of employees" } });
    sendToConnectorMock.mockImplementation(async (_manifest, credential) => ({
      ok: true,
      value: {
        columns: [{ name: "id", type: "number" as const }],
        rows: Array.from({ length: 1000 }, (_, i) => [i]),
        meta: {
          executedQuery: "SELECT COUNT(*) as id FROM employees",
          connectionId: credential.connectionId,
          durationMs: 5,
          rowCount: 1000,
          truncated: true,
        },
      },
    }));

    const graph = buildMultiSourceGraph();
    const finalState = await graph.invoke(initialState(["source-a", "source-b"], "how many employees are there in total?"));

    expect(finalState.refusal?.kind).toBe("partial-failure");
    expect(finalState.refusal?.message).toMatch(/truncated/i);
    expect(streamCompleteMock).not.toHaveBeenCalled();
    expect(eventsOfType("done")).toHaveLength(0);
  });

  it("retries the multi-source answer once on a faithfulness conflict, then ships flagged", async () => {
    mockCompleteRouting({ faithfulVerdict: "CONFLICT: mentions a value not in the computed result" });
    sendToConnectorMock.mockImplementation(async (_manifest, credential) => {
      const salary = credential.connectionId === "source-a" ? 100000 : 200000;
      return { ok: true, value: tabularResult(credential.connectionId, salary) };
    });

    const graph = buildMultiSourceGraph();
    const finalState = await graph.invoke(initialState(["source-a", "source-b"]));

    expect(streamCompleteMock).toHaveBeenCalledTimes(2);
    expect(finalState.faithful).toBe(false);
    expect(finalState.error).toBeUndefined();

    const doneEvents = eventsOfType("done");
    expect(doneEvents).toEqual([{ type: "done", faithful: false, truncated: false }]);
  });
});
