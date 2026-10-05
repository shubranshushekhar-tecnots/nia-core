import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../ops/logger.js";
import { JobScheduler, type SchedulerJob, type SchedulerJobOutcome } from "../scheduler/jobScheduler.js";
import { CheckInLoop } from "./checkInLoop.js";
import { LinkRevokedError, LinkTransientError, type AgentTransport, type CheckInResponse } from "./transport.js";

function job(overrides: Partial<SchedulerJob> = {}): SchedulerJob {
  return { id: "job-1", name: "Test job", connectionId: "conn-1", schedule: "* * * * *", timeZone: "UTC", ...overrides };
}

const OK: SchedulerJobOutcome = { ok: true, rowsSent: 0, durationMs: 0 };

describe("CheckInLoop", () => {
  let dir: string;
  let logger: Logger;

  beforeEach(async () => {
    vi.useFakeTimers();
    dir = await mkdtemp(path.join(tmpdir(), "nia-agent-checkinloop-"));
    logger = new Logger(path.join(dir, "logs"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  it("Guard: a 401 stops the link while a scheduled job still runs", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const transport: AgentTransport = { checkIn: vi.fn(async (): Promise<CheckInResponse> => { throw new LinkRevokedError(); }) };
    const onRevoked = vi.fn();
    const loop = new CheckInLoop({ transport, agentVersion: "1.0.0", logger, onRevoked });

    const runJob = vi.fn(async (): Promise<SchedulerJobOutcome> => OK);
    const scheduler = new JobScheduler({ dir, logger, loadJobs: () => [job()], runJob });

    loop.start();
    scheduler.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.checkIn).toHaveBeenCalledTimes(1);
    expect(onRevoked).toHaveBeenCalledTimes(1);
    expect(runJob).toHaveBeenCalledTimes(1); // the job ran on schedule despite the revoked link

    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.checkIn).toHaveBeenCalledTimes(1); // the loop never ticks again after a revoke
    expect(runJob).toHaveBeenCalledTimes(2); // the job keeps running

    await loop.stop();
    await scheduler.stop();
  });

  it("Guard: with the platform unreachable, the loop backs off and a scheduled job still runs on time", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const transport: AgentTransport = {
      checkIn: vi.fn(async (): Promise<CheckInResponse> => {
        throw new LinkTransientError("platform unreachable");
      }),
    };
    const loop = new CheckInLoop({ transport, agentVersion: "1.0.0", logger, initialDelayMs: 1_000, maxDelayMs: 60_000 });

    const runJob = vi.fn(async (): Promise<SchedulerJobOutcome> => OK);
    const scheduler = new JobScheduler({ dir, logger, loadJobs: () => [job()], runJob });

    loop.start();
    scheduler.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(transport.checkIn).toHaveBeenCalledTimes(1); // first attempt, immediately

    await vi.advanceTimersByTimeAsync(1_000); // backs off 1s after the first failure
    expect(transport.checkIn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000); // backs off 2s after the second failure
    expect(transport.checkIn).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(4_000); // backs off 4s after the third failure — growing, not fixed
    expect(transport.checkIn).toHaveBeenCalledTimes(4);

    // the job's own 60s cron tick still fires on time, unaffected by the link's backoff
    await vi.advanceTimersByTimeAsync(53_000);
    expect(runJob).toHaveBeenCalledTimes(1);

    await loop.stop();
    await scheduler.stop();
  });
});
