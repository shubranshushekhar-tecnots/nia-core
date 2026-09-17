import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ConnectorManifest } from "@nia/schemas";
import type { ResolvedConnection } from "./resolveConnection.js";

const resolveConnectionMock = vi.fn();
vi.mock("./resolveConnection.js", () => ({ resolveConnection: (...args: unknown[]) => resolveConnectionMock(...args) }));

const resolveWriteGrantMock = vi.fn();
vi.mock("./resolveWriteGrant.js", () => ({ resolveWriteGrant: (...args: unknown[]) => resolveWriteGrantMock(...args) }));

const sendWriteRequestMock = vi.fn();
vi.mock("./connectorClient.js", () => ({ sendWriteRequest: (...args: unknown[]) => sendWriteRequestMock(...args) }));

const logExecutionAuditMock = vi.fn();
vi.mock("./executionAudit.js", () => ({ logExecutionAudit: (...args: unknown[]) => logExecutionAuditMock(...args) }));

const { dispatchWrite } = await import("./writeDispatch.js");

const CONNECTION_ID = "11111111-1111-1111-1111-111111111111";
const ACTOR_ID = "33333333-3333-3333-3333-333333333333";
const SCOPE = { orgId: "org-1" };

const manifest: ConnectorManifest = {
  id: "supabase",
  name: "Supabase",
  version: "1.0.0",
  category: "database",
  auth: { method: "credentials" },
  configSchema: [],
  operations: ["read", "insert"],
  capabilities: ["queryable", "etl_sink"],
  service: { host: "connector-supabase", port: 4030 },
};

const resolvedConnection: ResolvedConnection = {
  id: CONNECTION_ID,
  connectorId: "supabase",
  handle: "@supabase-sales",
  config: { host: "localhost", port: 5432, database: "sales" },
  ownerUserId: "44444444-4444-4444-4444-444444444444",
  credential: { connectionId: CONNECTION_ID, credVersion: 1, vaultRef: "read-vault-ref" },
  manifest,
};

const input = {
  entity: { namespace: "sales", name: "orders" },
  columns: ["id", "total"],
  rows: [[1, 100]],
  upsertKeys: ["id"],
};

describe("dispatchWrite", () => {
  beforeEach(() => {
    resolveConnectionMock.mockReset();
    resolveWriteGrantMock.mockReset();
    sendWriteRequestMock.mockReset();
    logExecutionAuditMock.mockReset();
    logExecutionAuditMock.mockResolvedValue(undefined);
  });

  it("returns connection-not-found and does NOT call resolveWriteGrant, sendWriteRequest, or the audit RPC", async () => {
    resolveConnectionMock.mockResolvedValue({
      ok: false,
      error: { kind: "connection-not-found", message: "Connection not found in the given scope." },
    });

    const result = await dispatchWrite(CONNECTION_ID, input, SCOPE, ACTOR_ID);

    expect(result).toEqual({
      ok: false,
      error: { kind: "connection-not-found", message: "Connection not found in the given scope." },
    });
    expect(resolveWriteGrantMock).not.toHaveBeenCalled();
    expect(sendWriteRequestMock).not.toHaveBeenCalled();
    expect(logExecutionAuditMock).not.toHaveBeenCalled();
  });

  it("returns grant-invalid when no covering grant exists, does NOT call sendWriteRequest, and DOES audit the rejection", async () => {
    resolveConnectionMock.mockResolvedValue({ ok: true, value: resolvedConnection });
    resolveWriteGrantMock.mockResolvedValue({
      ok: false,
      error: { kind: "grant-invalid", message: 'No confirmed, unrevoked write grant covers schema "sales" on connection ' + CONNECTION_ID + "." },
    });

    const result = await dispatchWrite(CONNECTION_ID, input, SCOPE, ACTOR_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("grant-invalid");
    expect(sendWriteRequestMock).not.toHaveBeenCalled();
    expect(logExecutionAuditMock).toHaveBeenCalledTimes(1);
    expect(logExecutionAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: CONNECTION_ID,
        actorUserId: ACTOR_ID,
        operation: "write",
        query: expect.stringContaining("rejected:"),
      }),
    );
  });

  it("signs a WriteContext, builds a WriteRequest with the grant's write credential (not the connection's read credential), and calls sendWriteRequest", async () => {
    resolveConnectionMock.mockResolvedValue({ ok: true, value: resolvedConnection });
    resolveWriteGrantMock.mockResolvedValue({
      ok: true,
      value: { grantId: "grant-1", credVersion: 7, vaultRef: "write-vault-ref" },
    });
    sendWriteRequestMock.mockResolvedValue({ ok: true, value: { written: 1, durationMs: 5 } });

    const result = await dispatchWrite(CONNECTION_ID, input, SCOPE, ACTOR_ID);

    expect(result).toEqual({ ok: true, value: { written: 1, durationMs: 5 } });
    expect(sendWriteRequestMock).toHaveBeenCalledTimes(1);
    const [passedManifest, request] = sendWriteRequestMock.mock.calls[0] as [
      ConnectorManifest,
      {
        credential: { connectionId: string; credVersion: number; vaultRef: string };
        entity: unknown;
        columns: string[];
        rows: unknown[][];
        upsertKeys: string[];
        context: { connectionId: string; grantId: string; entity: unknown; columns: string[]; signature: string };
      },
    ];
    expect(passedManifest.id).toBe("supabase");
    expect(request.credential).toEqual({ connectionId: CONNECTION_ID, credVersion: 7, vaultRef: "write-vault-ref" });
    expect(request.entity).toEqual(input.entity);
    expect(request.columns).toEqual(input.columns);
    expect(request.rows).toEqual(input.rows);
    expect(request.upsertKeys).toEqual(input.upsertKeys);
    expect(request.context.connectionId).toBe(CONNECTION_ID);
    expect(request.context.grantId).toBe("grant-1");
    expect(typeof request.context.signature).toBe("string");
    expect(request.context.signature.length).toBeGreaterThan(0);

    expect(logExecutionAuditMock).toHaveBeenCalledTimes(1);
    expect(logExecutionAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: CONNECTION_ID, actorUserId: ACTOR_ID, operation: "write", query: expect.stringContaining("wrote 1 row(s)") }),
    );
  });

  it("propagates a sendWriteRequest failure and DOES audit it with the error message", async () => {
    resolveConnectionMock.mockResolvedValue({ ok: true, value: resolvedConnection });
    resolveWriteGrantMock.mockResolvedValue({
      ok: true,
      value: { grantId: "grant-1", credVersion: 7, vaultRef: "write-vault-ref" },
    });
    sendWriteRequestMock.mockResolvedValue({ ok: false, error: { kind: "service-error", message: "boom" } });

    const result = await dispatchWrite(CONNECTION_ID, input, SCOPE, ACTOR_ID);

    expect(result).toEqual({ ok: false, error: { kind: "service-error", message: "boom" } });
    expect(logExecutionAuditMock).toHaveBeenCalledWith(expect.objectContaining({ query: expect.stringContaining("boom") }));
  });
});
