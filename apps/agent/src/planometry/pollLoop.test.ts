import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jitteredDelayMs, runPollLoop } from "./pollLoop.js";
import { PlanometryClient } from "./client.js";
import { FakePlanometryServer } from "../testing/fakePlanometryServer.js";

describe("jitteredDelayMs", () => {
  it("stays within the jitter fraction of the base delay", () => {
    for (let i = 0; i < 20; i++) {
      const ms = jitteredDelayMs(10, 0.2);
      expect(ms).toBeGreaterThanOrEqual(8_000);
      expect(ms).toBeLessThanOrEqual(12_000);
    }
  });
});

describe("runPollLoop", () => {
  let server: FakePlanometryServer;
  let client: PlanometryClient;

  beforeEach(async () => {
    server = await FakePlanometryServer.start();
    client = new PlanometryClient({ baseUrl: server.baseUrl, agentKey: "k", agentVersion: "0.0.1" });
    server.setPollAfterSeconds(0);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("invokes onWork for each queued item, then stops on abort", async () => {
    server.enqueueWork("conn-1", { runId: "run-1", request: { table: "t", columns: ["a"], filter: [] } });
    server.enqueueWork("conn-1", { runId: "run-2", request: { table: "t", columns: ["a"], filter: [] } });

    const seen: string[] = [];
    const controller = new AbortController();

    const loop = runPollLoop({
      client,
      connectionId: "conn-1",
      signal: controller.signal,
      onWork: async (work) => {
        seen.push(work.runId);
        if (seen.length === 2) controller.abort();
      },
    });

    await loop;
    expect(seen).toEqual(["run-1", "run-2"]);
  });
});
