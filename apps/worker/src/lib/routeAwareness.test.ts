import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ConnectorManifest } from "@nia/schemas";
import { warnIfRouteMissing } from "./routeAwareness.js";

const manifest: ConnectorManifest = {
  id: "mysql-route-test",
  name: "MySQL",
  version: "1.0.0",
  category: "database",
  auth: { method: "credentials" },
  configSchema: [],
  operations: ["read"],
  capabilities: ["queryable"],
  service: { host: "connector-mysql", port: 4010 },
};

describe("warnIfRouteMissing", () => {
  const originalFetch = global.fetch;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    global.fetch = vi.fn();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    global.fetch = originalFetch;
    warnSpy.mockRestore();
  });

  it("warns when the connector's advertised routes don't include the one about to be dispatched", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", service: "connector-mysql", pools: 0, routes: ["test", "introspect", "execute", "invalidate"] }), {
        status: 200,
      }),
    );

    warnIfRouteMissing(manifest, "write");
    // fire-and-forget — flush the microtask queue so the .then() runs.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('does not advertise route "write"');
  });

  it("does not warn when the route is advertised", async () => {
    const advertisedManifest: ConnectorManifest = { ...manifest, id: "mysql-route-test-advertised" };
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", service: "connector-mysql", pools: 0, routes: ["test", "introspect", "execute", "invalidate"] }), {
        status: 200,
      }),
    );

    warnIfRouteMissing(advertisedManifest, "execute");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not warn (and does not throw) when the /health probe fails", async () => {
    const unreachableManifest: ConnectorManifest = { ...manifest, id: "mysql-route-test-unreachable" };
    vi.mocked(global.fetch).mockRejectedValue(new Error("connection refused"));

    expect(() => warnIfRouteMissing(unreachableManifest, "write")).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
