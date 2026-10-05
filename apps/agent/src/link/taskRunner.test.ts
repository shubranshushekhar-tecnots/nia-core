import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncJobEntry } from "../config/types.js";
import { loadConfig, saveConfig, upsertJob } from "../config/store.js";
import { Logger } from "../ops/logger.js";
import { pendingReports } from "./runReportOutbox.js";
import { JobScheduler, type SchedulerJobOutcome } from "../scheduler/jobScheduler.js";
import { TaskRunner } from "./taskRunner.js";
import type { AgentTask } from "./transport.js";
import type { TaskResultsClient } from "./taskResultsClient.js";

function platformJob(id: string): SyncJobEntry {
  return {
    id,
    name: `platform job ${id}`,
    connectionId: "conn-1",
    sourceTable: "dbo.Sales",
    targetUrl: "https://push.example.com/ingest",
    strategy: "replace",
    mapping: [{ source: "Id", target: "Id" }],
    targetSchemaSnapshot: { columns: [], keyColumns: [] },
    onNullKey: "stop",
    allowEmptyReplace: false,
    filter: [],
    params: {},
    platformManaged: { setupId: id, appliedVersion: 1 },
  };
}

/** `TaskResultsClient` has private fields, so a plain fake can't structurally satisfy it — cast through `unknown`, same posture as this file's other fakes. */
function fakeResultsClient(): TaskResultsClient & { post: ReturnType<typeof vi.fn> } {
  const post = vi.fn(async () => {});
  return { post } as unknown as TaskResultsClient & { post: typeof post };
}

/** Lets pending microtasks/timers (TaskRunner's own async chain, JobScheduler's fire-and-forget run) settle — no fake timers here since no cron timer is ever armed (these jobs have no `schedule`). */
function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("TaskRunner", () => {
  let dir: string;
  let logger: Logger;
  let scheduler: JobScheduler | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-agent-taskrunner-"));
    logger = new Logger(path.join(dir, "logs"));
  });

  afterEach(async () => {
    await scheduler?.stop();
    scheduler = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("Allowed: run_now with fullReload starts a replace run for the platform-managed job, the task is reported as started, and the run report carries the setup id", async () => {
    const job = platformJob("setup-1");
    saveConfig(upsertJob(loadConfig(dir), job), dir);

    const runJob = vi.fn(async (): Promise<SchedulerJobOutcome> => ({ ok: true, rowsSent: 3, durationMs: 5 }));
    scheduler = new JobScheduler({
      dir,
      logger,
      loadJobs: () => [{ id: job.id, name: job.name, connectionId: job.connectionId, timeZone: "UTC" }],
      runJob,
    });
    scheduler.start();

    const resultsClient = fakeResultsClient();
    const runner = new TaskRunner(resultsClient, logger, dir, scheduler);
    const task: AgentTask = { id: "task-1", kind: "run_now", agentSetupId: "setup-1", payload: { fullReload: true } };
    runner.handle([task]);

    await flush();

    expect(resultsClient.post).toHaveBeenCalledWith({ taskId: "task-1", status: "done", result: { started: true } });
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(runJob.mock.calls[0]![2]).toBe(true); // forceReplace, from payload.fullReload

    const reports = pendingReports(dir);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ jobId: "setup-1", setupId: "setup-1", status: "ok" });
  });

  it("Refused: a task for an unknown setup fails with a reason, and run_now while the job is already running is refused", async () => {
    const resultsClient = fakeResultsClient();

    // Unknown setup — no job with this id exists on this agent.
    const runnerNoScheduler = new TaskRunner(resultsClient, logger, dir, undefined);
    runnerNoScheduler.handle([{ id: "t1", kind: "pause", agentSetupId: "no-such-setup", payload: {} }]);
    await flush();
    expect(resultsClient.post).toHaveBeenCalledWith({ taskId: "t1", status: "failed", errorClass: "job not found on this agent" });

    // Already running — a second run_now while the first is still in flight is refused.
    const job = platformJob("setup-2");
    saveConfig(upsertJob(loadConfig(dir), job), dir);
    let releaseRun: (() => void) | undefined;
    const runJob = vi.fn(
      () =>
        new Promise<SchedulerJobOutcome>((resolve) => {
          releaseRun = () => resolve({ ok: true, rowsSent: 0, durationMs: 0 });
        }),
    );
    scheduler = new JobScheduler({
      dir,
      logger,
      loadJobs: () => [{ id: job.id, name: job.name, connectionId: job.connectionId, timeZone: "UTC" }],
      runJob,
    });
    scheduler.start();
    const runner = new TaskRunner(resultsClient, logger, dir, scheduler);

    runner.handle([{ id: "t2", kind: "run_now", agentSetupId: "setup-2", payload: {} }]);
    await flush();
    runner.handle([{ id: "t3", kind: "run_now", agentSetupId: "setup-2", payload: {} }]);
    await flush();

    expect(resultsClient.post).toHaveBeenCalledWith({ taskId: "t2", status: "done", result: { started: true } });
    expect(resultsClient.post).toHaveBeenCalledWith({ taskId: "t3", status: "failed", errorClass: "already running" });

    releaseRun?.();
    await flush();
  });
});
