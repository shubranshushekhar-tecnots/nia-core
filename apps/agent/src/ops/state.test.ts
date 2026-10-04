import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getStatus,
  isJobPaused,
  jobHealthState,
  pauseJobState,
  readJobState,
  readState,
  recordAgentStarted,
  recordJobFailure,
  recordJobSkipped,
  recordJobSuccess,
  recordNextRunAt,
  resumeJobState,
} from "./state.js";

describe("agent state", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "nia-agent-state-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns an empty state when no file exists yet", () => {
    expect(readState(dir)).toEqual({});
    expect(getStatus(dir)).toEqual({ startedAt: undefined, uptimeSeconds: undefined, jobs: {} });
  });

  it("records agent start and reports uptime", () => {
    recordAgentStarted(dir);
    const status = getStatus(dir);
    expect(status.startedAt).toBeDefined();
    expect(status.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("records job success, clearing any prior error", () => {
    recordJobFailure("job-1", { errorClass: "transient", message: "boom" }, dir);
    recordJobSuccess("job-1", { rowsSent: 42, durationMs: 100 }, dir);

    const state = readJobState("job-1", dir);
    expect(state).toMatchObject({ rowsSent: 42, consecutiveFailures: 0 });
    expect(state.lastError).toBeUndefined();
  });

  it("records job failure without disturbing other jobs", () => {
    recordJobSuccess("job-1", { rowsSent: 10, durationMs: 50 }, dir);
    recordJobFailure("job-2", { errorClass: "transient", message: "timeout" }, dir);

    expect(readJobState("job-1", dir)).toMatchObject({ rowsSent: 10 });
    expect(readJobState("job-2", dir).lastError).toMatchObject({ class: "transient", message: "timeout" });
  });

  it("increments consecutive failures across repeated failures and returns the running count", () => {
    expect(recordJobFailure("job-1", { errorClass: "transient", message: "boom" }, dir)).toBe(1);
    expect(recordJobFailure("job-1", { errorClass: "transient", message: "boom again" }, dir)).toBe(2);
    expect(recordJobFailure("job-1", { errorClass: "transient", message: "boom again" }, dir)).toBe(3);
    expect(readJobState("job-1", dir)).toMatchObject({ consecutiveFailures: 3 });
  });

  it("resets consecutive failures to 0 on the next successful run", () => {
    recordJobFailure("job-1", { errorClass: "transient", message: "boom" }, dir);
    recordJobFailure("job-1", { errorClass: "transient", message: "boom" }, dir);
    recordJobSuccess("job-1", { rowsSent: 7, durationMs: 10 }, dir);

    expect(readJobState("job-1", dir)).toMatchObject({ consecutiveFailures: 0 });
  });

  it("records a skipped run without disturbing consecutiveFailures", () => {
    recordJobFailure("job-1", { errorClass: "transient", message: "boom" }, dir);
    recordJobSkipped("job-1", dir);
    expect(readJobState("job-1", dir)).toMatchObject({ lastResult: "skipped", consecutiveFailures: 1 });
  });

  it("records the next scheduled run time independently of run outcome", () => {
    const next = new Date("2026-02-01T00:00:00.000Z");
    recordNextRunAt("job-1", next, dir);
    expect(readJobState("job-1", dir).nextRunAt).toBe(next.toISOString());
  });

  it("pauses and resumes a job's state, reporting isJobPaused accordingly", () => {
    expect(isJobPaused("job-1", dir)).toBe(false);
    pauseJobState("job-1", "401 unauthorized", dir);
    expect(isJobPaused("job-1", dir)).toBe(true);
    expect(readJobState("job-1", dir).paused).toMatchObject({ reason: "401 unauthorized" });

    resumeJobState("job-1", dir);
    expect(isJobPaused("job-1", dir)).toBe(false);
  });

  it("derives ok/failing/paused health from job state", () => {
    expect(jobHealthState({ consecutiveFailures: 0 })).toBe("ok");
    expect(jobHealthState({ consecutiveFailures: 2 })).toBe("failing");
    expect(jobHealthState({ consecutiveFailures: 2, paused: { reason: "x", at: "now" } })).toBe("paused");
  });

  it("getStatus enumerates every job with a state file, keyed by job id", () => {
    recordJobSuccess("job-1", { rowsSent: 1, durationMs: 1 }, dir);
    recordJobFailure("job-2", { errorClass: "config", message: "401" }, dir);
    const status = getStatus(dir);
    expect(Object.keys(status.jobs).sort()).toEqual(["job-1", "job-2"]);
  });
});
