import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { runAgentLoop } = await import("./agentLoop.js");
const { getStatus } = await import("./ops/state.js");

describe("runAgentLoop", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "nia-agent-loop-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("stops promptly on abort with no connections configured", async () => {
    const controller = new AbortController();
    const loop = runAgentLoop({ dir, agentVersion: "0.0.1", signal: controller.signal });
    controller.abort();
    await loop;
    expect(getStatus(dir).startedAt).toBeDefined();
  });
});
