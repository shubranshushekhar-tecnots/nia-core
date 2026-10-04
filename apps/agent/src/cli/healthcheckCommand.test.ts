import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordAgentStarted } from "../ops/state.js";
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

  it("is healthy once started, even with no jobs run yet", () => {
    recordAgentStarted(dir);
    expect(runHealthcheck(dir)).toEqual({ healthy: true });
  });
});
