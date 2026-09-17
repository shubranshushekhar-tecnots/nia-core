import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ConnectorManifest, CredentialRef, WriteRequest } from "@nia/schemas";
import { validateBeforeDispatch } from "@nia/guardrails";
import { sendToConnector, sendWriteRequest } from "./connectorClient.js";

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

/**
 * connectorClient.ts's send* functions now fire an extra, non-awaited
 * /health probe (routeAwareness.ts's warnIfRouteMissing) before the real
 * dispatch call. A plain `vi.fn().mockResolvedValue(response)` returns the
 * SAME Response instance for every call, so without this, the /health
 * probe's `res.json()` would consume the one body the real assertion below
 * needs — a test-mock artifact only (real fetch always returns an
 * independent Response per call). Route /health to its own canned response
 * and give every other URL a freshly-constructed Response per call.
 */
function healthResponse(): Response {
  return new Response(
    JSON.stringify({ status: "ok", service: "test-connector", pools: 0, routes: ["test", "introspect", "execute", "invalidate", "write"] }),
    { status: 200 },
  );
}
function mockFetch(mainImpl: () => Promise<Response>) {
  global.fetch = vi.fn((url: string | URL | Request) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (href.endsWith("/health")) return Promise.resolve(healthResponse());
    return mainImpl();
  }) as unknown as typeof fetch;
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
    mockFetch(() => Promise.resolve(new Response(JSON.stringify(tabularResult), { status: 200 })));

    const result = await sendToConnector(manifest, credential, {}, validQuery());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(tabularResult);
  });

  it("normalizes a non-2xx response to service-error", async () => {
    mockFetch(() => Promise.resolve(new Response(JSON.stringify({ message: "boom" }), { status: 500 })));

    const result = await sendToConnector(manifest, credential, {}, validQuery());
    expect(result).toEqual({ ok: false, error: { kind: "service-error", message: "boom" } });
  });

  it("normalizes a network failure to service-unreachable", async () => {
    mockFetch(() => Promise.reject(new Error("ECONNREFUSED")));

    const result = await sendToConnector(manifest, credential, {}, validQuery());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("service-unreachable");
  });

  it("normalizes an aborted request to query-timeout", async () => {
    mockFetch(() => {
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
    mockFetch(() => Promise.resolve(new Response(JSON.stringify({ not: "tabular" }), { status: 200 })));

    const result = await sendToConnector(manifest, credential, {}, validQuery());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("service-error");
  });
});

const supabaseManifest: ConnectorManifest = {
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

function writeRequest(): WriteRequest {
  return {
    credential: { connectionId: credential.connectionId, credVersion: 1, vaultRef: "write-vault-ref" },
    config: {},
    entity: { namespace: "sales", name: "orders" },
    columns: ["id", "total"],
    rows: [[1, 100]],
    upsertKeys: ["id"],
    timeoutMs: 15000,
    context: {
      connectionId: credential.connectionId,
      grantId: "22222222-2222-2222-2222-222222222222",
      entity: { namespace: "sales", name: "orders" },
      columns: ["id", "total"],
      issuedAt: Date.now(),
      signature: "deadbeef",
    },
  };
}

describe("sendWriteRequest", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns ok with the parsed WriteResponse on a successful response", async () => {
    mockFetch(() => Promise.resolve(new Response(JSON.stringify({ written: 3, durationMs: 12 }), { status: 200 })));

    const result = await sendWriteRequest(supabaseManifest, writeRequest());
    expect(result).toEqual({ ok: true, value: { written: 3, durationMs: 12 } });
  });

  it("normalizes a non-2xx response to service-error", async () => {
    mockFetch(() => Promise.resolve(new Response(JSON.stringify({ message: "no confirmed, unrevoked write grant covers this entity" }), { status: 500 })));

    const result = await sendWriteRequest(supabaseManifest, writeRequest());
    expect(result).toEqual({
      ok: false,
      error: { kind: "service-error", message: "no confirmed, unrevoked write grant covers this entity" },
    });
  });

  it("normalizes a network failure to service-unreachable", async () => {
    mockFetch(() => Promise.reject(new Error("ECONNREFUSED")));

    const result = await sendWriteRequest(supabaseManifest, writeRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("service-unreachable");
  });

  it("normalizes an aborted request to query-timeout", async () => {
    mockFetch(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });

    const result = await sendWriteRequest(supabaseManifest, writeRequest(), { timeoutMs: 10 });
    expect(result).toEqual({
      ok: false,
      error: { kind: "query-timeout", message: 'Write against connector "supabase" timed out after 10ms.' },
    });
  });

  it("normalizes a malformed success-status response to service-error", async () => {
    mockFetch(() => Promise.resolve(new Response(JSON.stringify({ not: "a write response" }), { status: 200 })));

    const result = await sendWriteRequest(supabaseManifest, writeRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("service-error");
  });
});
