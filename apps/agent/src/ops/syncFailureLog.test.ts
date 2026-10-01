import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Logger } from "./logger.js";
import { logSyncFailure, REPEATED_FAILURE_THRESHOLD } from "./syncFailureLog.js";

describe("logSyncFailure", () => {
  let dir: string;
  let logger: Logger;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "nia-agent-sync-failure-log-"));
    logger = new Logger(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function readLines() {
    const content = await readFile(path.join(dir, "agent.log"), "utf8");
    return content.trim().split("\n").map((l) => JSON.parse(l));
  }

  it("logs a single failure as a warning", async () => {
    logSyncFailure(logger, "conn-1", "timeout", 1);
    const [line] = await readLines();
    expect(line).toMatchObject({ level: "warn", event: "sync_failed", connectionId: "conn-1", consecutiveFailures: 1 });
  });

  it("escalates to error once the repeated-failure threshold is reached", async () => {
    logSyncFailure(logger, "conn-1", "timeout", REPEATED_FAILURE_THRESHOLD);
    const [line] = await readLines();
    expect(line).toMatchObject({ level: "error", event: "repeated_sync_failures", connectionId: "conn-1", consecutiveFailures: REPEATED_FAILURE_THRESHOLD });
  });

  it("keeps escalating for every failure past the threshold", async () => {
    logSyncFailure(logger, "conn-1", "timeout", REPEATED_FAILURE_THRESHOLD + 5);
    const [line] = await readLines();
    expect(line).toMatchObject({ level: "error", event: "repeated_sync_failures" });
  });
});
