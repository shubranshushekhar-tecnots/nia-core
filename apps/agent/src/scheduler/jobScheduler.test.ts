import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMonitoringHeartbeatPayload } from "../ops/monitoringHeartbeat.js";
import { Logger } from "../ops/logger.js";
import { isJobPaused, readJobState, recordNextRunAt, resumeJobState } from "../ops/state.js";
import { JobScheduler, type SchedulerJob, type SchedulerJobOutcome } from "./jobScheduler.js";

function job(overrides: Partial<SchedulerJob> = {}): SchedulerJob {
  return { id: "job-1", name: "Test job", connectionId: "conn-1", schedule: "* * * * *", timeZone: "UTC", ...overrides };
}

const OK: SchedulerJobOutcome = { ok: true, rowsSent: 0, durationMs: 0 };

describe("JobScheduler", () => {
  let dir: string;
  let logDir: string;
  let logger: Logger;

  beforeEach(async () => {
    vi.useFakeTimers();
    dir = await mkdtemp(path.join(tmpdir(), "nia-agent-scheduler-"));
    logDir = path.join(dir, "logs");
    logger = new Logger(logDir);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  it("one job's run throwing does not stop another job from running", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const jobA = job({ id: "a" });
    const jobB = job({ id: "b" });
    const runJob = vi.fn(async (j: SchedulerJob): Promise<SchedulerJobOutcome> => {
      if (j.id === "a") throw new Error("boom");
      return OK;
    });
    const scheduler = new JobScheduler({ dir, logger, loadJobs: () => [jobA, jobB], runJob, maxConcurrentRuns: 2 });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runJob).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it("a job fires at its cron time in the connection's timezone", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const j = job({ schedule: "0 9 * * *", timeZone: "America/New_York" }); // 9am EST = 14:00 UTC in January
    const runJob = vi.fn(async (): Promise<SchedulerJobOutcome> => OK);
    const scheduler = new JobScheduler({ dir, logger, loadJobs: () => [j], runJob });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(14 * 60 * 60 * 1000 - 1_000);
    expect(runJob).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runJob).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  it("a tick while the same job is still running is skipped", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const j = job();
    let resolveRun: (() => void) | undefined;
    const runJob = vi.fn(
      () =>
        new Promise<SchedulerJobOutcome>((resolve) => {
          resolveRun = () => resolve(OK);
        }),
    );
    const scheduler = new JobScheduler({ dir, logger, loadJobs: () => [j], runJob });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runJob).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000); // next tick fires while the first run is still pending
    expect(runJob).toHaveBeenCalledTimes(1);
    resolveRun?.();
    await vi.advanceTimersByTimeAsync(0);
    await scheduler.stop();
  });

  it("isRunning is true only while a run is actually in flight", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const j = job();
    let resolveRun: (() => void) | undefined;
    const runJob = vi.fn(
      () =>
        new Promise<SchedulerJobOutcome>((resolve) => {
          resolveRun = () => resolve(OK);
        }),
    );
    const scheduler = new JobScheduler({ dir, logger, loadJobs: () => [j], runJob });
    expect(scheduler.isRunning(j.id)).toBe(false); // not started yet -- unknown to the scheduler
    scheduler.start();
    expect(scheduler.isRunning(j.id)).toBe(false); // known now, but no tick has fired yet
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scheduler.isRunning(j.id)).toBe(true); // tick fired, run in flight
    resolveRun?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.isRunning(j.id)).toBe(false); // settled
    await scheduler.stop();
  });

  it("isRunning is false for a job id the scheduler doesn't know about", async () => {
    const scheduler = new JobScheduler({ dir, logger, loadJobs: () => [], runJob: vi.fn(async (): Promise<SchedulerJobOutcome> => OK) });
    expect(scheduler.isRunning("unknown-job")).toBe(false);
  });

  it("a 401 pauses the job; later ticks are skipped until job resume", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const j = job();
    const runJob = vi.fn(async (): Promise<SchedulerJobOutcome> => ({ ok: false, kind: "config", error: "401 unauthorized" }));
    const scheduler = new JobScheduler({ dir, logger, loadJobs: () => [j], runJob });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(isJobPaused(j.id, dir)).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runJob).toHaveBeenCalledTimes(1); // still paused — tick skipped

    resumeJobState(j.id, dir);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runJob).toHaveBeenCalledTimes(2); // resumed — runs again

    await scheduler.stop();
  });

  it("a transient failure retries with backoff and does not pause", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const j = job();
    const runJob = vi.fn(async (): Promise<SchedulerJobOutcome> => ({ ok: false, kind: "transient", error: "network down" }));
    const scheduler = new JobScheduler({ dir, logger, loadJobs: () => [j], runJob, retryDelaysMs: [1_000, 2_000, 3_000] });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runJob).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runJob).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(runJob).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(runJob).toHaveBeenCalledTimes(4); // retries exhausted — fails, still not paused
    expect(isJobPaused(j.id, dir)).toBe(false);
    await scheduler.stop();
  });

  it("a run missed while the agent was down runs once at startup", async () => {
    const j = job();
    recordNextRunAt(j.id, new Date("2025-12-31T23:58:00.000Z"), dir); // persisted from before the (simulated) restart
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const runJob = vi.fn(async (): Promise<SchedulerJobOutcome> => OK);
    const scheduler = new JobScheduler({ dir, logger, loadJobs: () => [j], runJob });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0); // the missed run fires immediately
    expect(runJob).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(59_000);
    expect(runJob).toHaveBeenCalledTimes(1); // no backfill of the missed tick(s)
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runJob).toHaveBeenCalledTimes(2); // next *future* occurrence from startup, on schedule

    await scheduler.stop();
  });

  it("with maxConcurrentRuns 1, a second job waits for the first to finish", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const jobA = job({ id: "a" });
    const jobB = job({ id: "b" });
    const order: string[] = [];
    let resolveA: (() => void) | undefined;
    const runJob = vi.fn((j: SchedulerJob): Promise<SchedulerJobOutcome> => {
      order.push(`${j.id}-start`);
      if (j.id === "a") {
        return new Promise((resolve) => {
          resolveA = () => {
            order.push("a-end");
            resolve(OK);
          };
        });
      }
      order.push("b-end");
      return Promise.resolve(OK);
    });
    const scheduler = new JobScheduler({ dir, logger, loadJobs: () => [jobA, jobB], runJob, maxConcurrentRuns: 1 });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(order).toEqual(["a-start"]); // b is queued on the semaphore, hasn't started yet
    resolveA?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
    await scheduler.stop();
  });

  it("a job added while the service is running is picked up without restart", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    let jobs: SchedulerJob[] = [];
    const runJob = vi.fn(async (): Promise<SchedulerJobOutcome> => OK);
    const scheduler = new JobScheduler({ dir, logger, loadJobs: () => jobs, runJob, reconcileIntervalMs: 1_000 });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runJob).not.toHaveBeenCalled();

    jobs = [job({ id: "new-job" })];
    await vi.advanceTimersByTimeAsync(1_000); // next reconcile picks it up, well under the 60s bound
    await vi.advanceTimersByTimeAsync(60_000); // its first cron tick
    expect(runJob).toHaveBeenCalledTimes(1);

    await scheduler.stop();
  });

  it("the webhook payload and the log contain no Planometry 400 message", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const rawMessage = "Planometry 400: column 'ssn' does not exist on target table xyz";
    const j = job();
    const runJob = vi.fn(async (): Promise<SchedulerJobOutcome> => ({ ok: false, kind: "config", error: "401 unauthorized", consoleMessage: rawMessage }));
    const scheduler = new JobScheduler({ dir, logger, loadJobs: () => [j], runJob });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await scheduler.stop();

    const state = readJobState(j.id, dir);
    expect(state.lastConsoleMessage).toBe(rawMessage); // allowed in the state file only

    const logContents = readFileSync(path.join(logDir, "agent.log"), "utf8");
    expect(logContents).not.toContain(rawMessage);

    const payload = buildMonitoringHeartbeatPayload("1.0.0", [{ id: j.id, name: j.name, state }]);
    expect(JSON.stringify(payload)).not.toContain(rawMessage);
  });
});
