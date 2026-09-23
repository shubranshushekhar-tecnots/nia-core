import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ConnectorManifest } from "@nia/schemas";
import type { ResolvedConnection } from "./resolveConnection.js";

const resolveConnectionMock = vi.fn();
vi.mock("./resolveConnection.js", () => ({ resolveConnection: (...args: unknown[]) => resolveConnectionMock(...args) }));

const sendToConnectorMock = vi.fn();
vi.mock("./connectorClient.js", () => ({ sendToConnector: (...args: unknown[]) => sendToConnectorMock(...args) }));

const logExecutionAuditMock = vi.fn();
vi.mock("./executionAudit.js", () => ({ logExecutionAudit: (...args: unknown[]) => logExecutionAuditMock(...args) }));

const { dispatch } = await import("./dispatch.js");

const CONNECTION_ID = "11111111-1111-1111-1111-111111111111";
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

const resolvedConnection: ResolvedConnection = {
  id: CONNECTION_ID,
  connectorId: "mysql",
  handle: "@mysql-sales",
  config: { host: "localhost", port: 3306, database: "sales" },
  ownerUserId: "44444444-4444-4444-4444-444444444444",
  credential: { connectionId: CONNECTION_ID, credVersion: 1, vaultRef: "vault-ref-1" },
  manifest,
};

const query = { kind: "sql" as const, sql: "SELECT 1", params: [] };

describe("dispatch", () => {
  beforeEach(() => {
    resolveConnectionMock.mockReset();
    sendToConnectorMock.mockReset();
    logExecutionAuditMock.mockReset();
    logExecutionAuditMock.mockResolvedValue(undefined);
  });

  it("returns connection-not-found and does NOT call the audit RPC — there's no connection row to attribute it to", async () => {
    resolveConnectionMock.mockResolvedValue({
      ok: false,
      error: { kind: "connection-not-found", message: "Connection not found in the given scope." },
    });

    const result = await dispatch(CONNECTION_ID, query, SCOPE, ACTOR_ID);

    expect(result).toEqual({
      ok: false,
      error: { kind: "connection-not-found", message: "Connection not found in the given scope." },
    });
    expect(sendToConnectorMock).not.toHaveBeenCalled();
    expect(logExecutionAuditMock).not.toHaveBeenCalled();
  });

  it("returns guardrail-rejected for a query the connector's validator rejects, and DOES audit the attempt", async () => {
    resolveConnectionMock.mockResolvedValue({ ok: true, value: resolvedConnection });

    // mysql's guardrail validator rejects anything that isn't kind: "sql".
    const mongoShapedQuery = { kind: "mongo" as const, collection: "orders", pipeline: [] };
    const result = await dispatch(CONNECTION_ID, mongoShapedQuery, SCOPE, ACTOR_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("guardrail-rejected");
    expect(sendToConnectorMock).not.toHaveBeenCalled();
    expect(logExecutionAuditMock).toHaveBeenCalledTimes(1);
    expect(logExecutionAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: CONNECTION_ID, actorUserId: ACTOR_ID }),
    );
  });

  it("returns service-unreachable when the connector service can't be reached, and DOES audit it", async () => {
    resolveConnectionMock.mockResolvedValue({ ok: true, value: resolvedConnection });
    sendToConnectorMock.mockResolvedValue({ ok: false, error: { kind: "service-unreachable", message: "ECONNREFUSED" } });

    const result = await dispatch(CONNECTION_ID, query, SCOPE, ACTOR_ID);

    expect(result).toEqual({ ok: false, error: { kind: "service-unreachable", message: "ECONNREFUSED" } });
    expect(logExecutionAuditMock).toHaveBeenCalledTimes(1);
  });

  it("returns service-error when the connector service responds with an error, and DOES audit it", async () => {
    resolveConnectionMock.mockResolvedValue({ ok: true, value: resolvedConnection });
    sendToConnectorMock.mockResolvedValue({ ok: false, error: { kind: "service-error", message: "boom" } });

    const result = await dispatch(CONNECTION_ID, query, SCOPE, ACTOR_ID);

    expect(result).toEqual({ ok: false, error: { kind: "service-error", message: "boom" } });
    expect(logExecutionAuditMock).toHaveBeenCalledTimes(1);
  });

  it("returns query-timeout when the connector service call times out, and DOES audit it", async () => {
    resolveConnectionMock.mockResolvedValue({ ok: true, value: resolvedConnection });
    sendToConnectorMock.mockResolvedValue({ ok: false, error: { kind: "query-timeout", message: "timed out after 15000ms" } });

    const result = await dispatch(CONNECTION_ID, query, SCOPE, ACTOR_ID);

    expect(result).toEqual({ ok: false, error: { kind: "query-timeout", message: "timed out after 15000ms" } });
    expect(logExecutionAuditMock).toHaveBeenCalledTimes(1);
  });

  it("returns ok with the TabularResult on success, and audits with the connector's executedQuery", async () => {
    resolveConnectionMock.mockResolvedValue({ ok: true, value: resolvedConnection });
    const tabularResult = {
      columns: [{ name: "id", type: "number" }],
      rows: [[1]],
      meta: { executedQuery: "SELECT 1 -- sanitized", connectionId: CONNECTION_ID, durationMs: 5, rowCount: 1, truncated: false },
    };
    sendToConnectorMock.mockResolvedValue({ ok: true, value: tabularResult });

    const result = await dispatch(CONNECTION_ID, query, SCOPE, ACTOR_ID);

    expect(result).toEqual({ ok: true, value: tabularResult });
    expect(logExecutionAuditMock).toHaveBeenCalledTimes(1);
    expect(logExecutionAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ query: "SELECT 1 -- sanitized", connectionId: CONNECTION_ID, actorUserId: ACTOR_ID }),
    );
  });

  it("passes a ValidatedQuery matching the resolved connection's connectorId to sendToConnector", async () => {
    resolveConnectionMock.mockResolvedValue({ ok: true, value: resolvedConnection });
    sendToConnectorMock.mockResolvedValue({
      ok: true,
      value: { columns: [], rows: [], meta: { executedQuery: "SELECT 1", connectionId: CONNECTION_ID, durationMs: 1, rowCount: 0, truncated: false } },
    });

    await dispatch(CONNECTION_ID, query, SCOPE, ACTOR_ID);

    expect(sendToConnectorMock).toHaveBeenCalledTimes(1);
    const [passedManifest, , , validated] = sendToConnectorMock.mock.calls[0] as [ConnectorManifest, unknown, unknown, { manifestId: string }];
    expect(passedManifest.id).toBe("mysql");
    expect(validated.manifestId).toBe("mysql");
  });
});
