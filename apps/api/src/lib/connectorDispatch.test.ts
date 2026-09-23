import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ConnectorManifest, CredentialRef } from "@nia/schemas";
import { dispatchIntrospect } from "./connectorDispatch.js";

/**
 * Bug fix (Neon /introspect 500): a non-2xx connector response used to
 * collapse to "connector service responded 500", discarding the connector's
 * own `message` (e.g. connector-supabase's Fastify default error handler
 * returns {statusCode, code, error, message} for a pg error like "connection
 * is insecure (try using `sslmode=require`)"). This asserts the real message
 * now makes it into dispatchIntrospect's returned error, same pattern
 * apps/worker's connectorClient.ts already uses for sendToConnector.
 */
const manifest: ConnectorManifest = {
  id: "postgres",
  name: "PostgreSQL",
  version: "0.0.1",
  category: "database",
  auth: { method: "credentials" },
  configSchema: [],
  operations: ["read", "insert"],
  capabilities: ["queryable", "etl_source", "etl_sink"],
  service: { host: "connector-supabase", port: 4030 },
};

const credential: CredentialRef = {
  connectionId: "11111111-1111-1111-1111-111111111111",
  credVersion: 1,
  vaultRef: "vault-ref",
};

describe("dispatchIntrospect", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("surfaces the connector's actual error message, not just the status code", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            statusCode: 500,
            code: "28000",
            error: "Internal Server Error",
            message: "connection is insecure (try using `sslmode=require`)",
          }),
          { status: 500 },
        ),
      ),
    ) as unknown as typeof fetch;

    const result = await dispatchIntrospect(manifest, credential, { host: "x", port: 5432, database: "d" });

    expect(result).toEqual({
      ok: false,
      error: {
        message: "connector service responded 500: connection is insecure (try using `sslmode=require`)",
        details: "connector service responded 500: connection is insecure (try using `sslmode=require`)",
      },
    });
  });

  it("falls back to the status code alone when the body has no message", async () => {
    global.fetch = vi.fn(() => Promise.resolve(new Response("", { status: 502 }))) as unknown as typeof fetch;

    const result = await dispatchIntrospect(manifest, credential, { host: "x", port: 5432, database: "d" });

    expect(result).toEqual({
      ok: false,
      error: { message: "connector service responded 502", details: "connector service responded 502" },
    });
  });

  /**
   * Bug fix: a vault-connectivity failure (the connector's resolveVaultSecret
   * wraps a network error as "vault resolution failed for ref X: TypeError:
   * fetch failed") used to surface a raw TypeError string straight to the UI.
   * Now it maps to a plain-language headline while the raw connector text
   * stays available in `details`.
   */
  it("maps a vault-unreachable failure to a plain-language message, keeping the raw text in details", async () => {
    const rawMessage = "vault resolution failed for ref abc-123: TypeError: fetch failed";
    global.fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ statusCode: 500, message: rawMessage }), { status: 500 })),
    ) as unknown as typeof fetch;

    const result = await dispatchIntrospect(manifest, credential, { host: "x", port: 5432, database: "d" });

    expect(result).toEqual({
      ok: false,
      error: {
        message: "Can't reach the credential store.",
        details: `connector service responded 500: ${rawMessage}`,
      },
    });
  });
});
