import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ConnectorManifest, CredentialRef } from "@nia/schemas";
import { validateBeforeDispatch } from "@nia/guardrails";
import { sendToConnector } from "./connectorClient.js";

/**
 * Compile-time-only proof, alongside the runtime tests below: this file is
 * NOT excluded from `tsc --noEmit` (unlike every other package's
 * `src/**\/*.test.ts` — see apps/worker/tsconfig.json, which has no
 * `exclude`), so a `@ts-expect-error` here genuinely fails
 * `pnpm --filter @nia/worker typecheck` (and the root `turbo typecheck`) if
 * sendToConnector's signature ever loosens to accept a raw QueryPayload.
 * Wrapped in a never-invoked function so it has zero runtime effect.
 */
function _typeOnly_sendToConnectorRejectsRawQueryPayload(manifest: ConnectorManifest, credential: CredentialRef): void {
  // @ts-expect-error - sendToConnector must accept only a ValidatedQuery (@nia/guardrails), never a raw QueryPayload.
  void sendToConnector(manifest, credential, {}, { kind: "sql", sql: "select 1", params: [] });
}

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
const credential: CredentialRef = { connectionId: "11111111-1111-1111-1111-111111111111", credVersion: 1, vaultRef: "v1" };

function validQuery() {
  const result = validateBeforeDispatch("mysql", { kind: "sql", sql: "SELECT 1", params: [] }, { connectionId: credential.connectionId });
  if (!result.ok) throw new Error("expected validation to succeed in test setup");
  return result.sanitizedQuery;
}

describe("sendToConnector", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns ok with the parsed TabularResult on a successful response", async () => {
    const tabularResult = {
      columns: [{ name: "id", type: "number" }],
      rows: [[1]],
      meta: { executedQuery: "SELECT 1", connectionId: credential.connectionId, durationMs: 5, rowCount: 1, truncated: false },
    };
    vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify(tabularResult), { status: 200 }));

    const result = await sendToConnector(manifest, credential, {}, validQuery());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(tabularResult);
  });

  it("normalizes a non-2xx response to service-error", async () => {
    vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify({ message: "boom" }), { status: 500 }));

    const result = await sendToConnector(manifest, credential, {}, validQuery());
    expect(result).toEqual({ ok: false, error: { kind: "service-error", message: "boom" } });
  });

  it("normalizes a network failure to service-unreachable", async () => {
    vi.mocked(global.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await sendToConnector(manifest, credential, {}, validQuery());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("service-unreachable");
  });

  it("normalizes an aborted request to query-timeout", async () => {
    vi.mocked(global.fetch).mockImplementation(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });

    const result = await sendToConnector(manifest, credential, {}, validQuery(), { timeoutMs: 10 });
    expect(result).toEqual({
      ok: false,
      error: { kind: "query-timeout", message: 'Query against connector "mysql" timed out after 10ms.' },
    });
  });

  it("normalizes a malformed success-status response to service-error", async () => {
    vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify({ not: "tabular" }), { status: 200 }));

    const result = await sendToConnector(manifest, credential, {}, validQuery());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("service-error");
  });
});
