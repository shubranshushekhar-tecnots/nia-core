import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakePlatformServer } from "./testing/fakePlatformServer.js";

const { runAgentLoop } = await import("./agentLoop.js");
const { pair } = await import("./link/pairing.js");
const { addConnection } = await import("./core/connections.js");

/**
 * Reproduces exactly what the Windows CI harness's check C5 + check D1 do,
 * entirely in-process: `runAgentLoop` starts unpaired (like the service
 * freshly installed in check A), then — while it's still running, with no
 * restart — a *separate* call to `pair()` (standing in for a separate CLI
 * invocation) links it, and a connection is added the same way. Asserts the
 * live loop's own LinkWatcher/CheckInLoop notices the pairing and reports
 * the connection, with no restart, matching check D1's own assertion.
 */
async function waitUntil(predicate: () => boolean, timeoutMs: number, stepMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return predicate();
}

describe("runAgentLoop live re-pair (no restart)", () => {
  let dir: string;
  let fake: FakePlatformServer;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "nia-agent-live-repair-"));
    fake = await FakePlatformServer.start();
  });

  afterEach(async () => {
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("checks in and reports a connection added after pairing, without restarting the loop", async () => {
    const controller = new AbortController();
    const loop = runAgentLoop({ dir, agentVersion: "0.0.1", signal: controller.signal });

    try {
      const { composite } = fake.registerPairingCode();
      const { agentId } = await pair({ code: composite, url: fake.baseUrl }, dir);

      // Mirrors check C5: the connection is added to config *after* pairing,
      // from what stands in for a separate CLI process, while the loop is
      // already running unpaired-then-paired.
      addConnection(
        {
          id: "widgets",
          label: "Widgets",
          host: "localhost",
          port: 1433,
          database: "NiaAgentTestDB",
          user: "nia_ro",
          password: "whatever",
          sourceTimeZone: "UTC",
        },
        dir,
      );

      const sawConnection = await waitUntil(() => {
        const agent = fake.getAgent(agentId);
        return !!agent && agent.reportedConnections.length > 0;
      }, 15_000);

      const agent = fake.getAgent(agentId);
      expect(sawConnection, `reportedConnections never populated; last seen: ${JSON.stringify(agent?.reportedConnections)}`).toBe(true);
      expect(agent?.reportedConnections).toEqual([{ id: "widgets", name: "Widgets", database: "NiaAgentTestDB", dialect: "mssql" }]);
    } finally {
      controller.abort();
      await loop;
    }
  }, 20_000);
});
