import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordAgentStarted, recordPoll } from "../ops/state.js";
import { runHealthcheck } from "./healthcheckCommand.js";

describe("runHealthcheck", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "nia-agent-healthcheck-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is unhealthy when the agent has never recorded a start", () => {
    const result = runHealthcheck(dir);
    expect(result).toEqual({ healthy: false, reason: "agent has not recorded a start" });
  });

  it("is healthy once started, even with no connections polled yet", () => {
    recordAgentStarted(dir);
    expect(runHealthcheck(dir)).toEqual({ healthy: true });
  });

  it("is healthy when every connection's last poll is within the stale threshold", () => {
    recordAgentStarted(dir);
    recordPoll("conn-1", dir);
    expect(runHealthcheck(dir, 10_000)).toEqual({ healthy: true });
  });

  it("is unhealthy when a connection's last poll is older than the stale threshold", () => {
    recordAgentStarted(dir);
    recordPoll("conn-1", dir);
    const result = runHealthcheck(dir, -1);
    expect(result.healthy).toBe(false);
    expect(result.reason).toContain("conn-1");
    expect(result.reason).toContain("has not polled in");
  });
});
