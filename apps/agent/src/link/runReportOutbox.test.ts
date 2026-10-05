import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../ops/logger.js";
import { CheckInLoop } from "./checkInLoop.js";
import type { LocalJobReport } from "./localJobReports.js";
import { acknowledge, pendingReports, recordRun, type RunReport } from "./runReportOutbox.js";
import { LinkTransientError, type AgentTransport, type CheckInResponse } from "./transport.js";

/**
 * Guard (Slice L4 B.7) — a run report recorded while the platform is
 * unreachable must survive in the outbox, be included on every check-in
 * attempt while offline, and be removed only once the platform's response
 * explicitly acknowledges its runId. Exercises the real CheckInLoop (not a
 * reimplementation) wired to the real outbox functions, same as
 * agentLoop.ts wires them.
 */
describe("run report outbox — offline retention and acknowledged delivery", () => {
  let dir: string;
  let logger: Logger;

  beforeEach(async () => {
    vi.useFakeTimers();
    dir = await mkdtemp(path.join(tmpdir(), "nia-agent-runreportoutbox-"));
    logger = new Logger(path.join(dir, "logs"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps a report queued across failed check-ins and removes it once acknowledged", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    recordRun(dir, {
      jobId: "job-1",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "ok",
      rowsSent: 100,
      rowsDeleted: 0,
      parts: 1,
      isRealtime: false,
    });
    const [report] = pendingReports(dir);
    expect(report).toBeDefined();
    const runId = report!.runId;

    let fail = true;
    const checkIn = vi.fn(async (): Promise<CheckInResponse> => {
      if (fail) throw new LinkTransientError("platform unreachable");
      return { tasks: [], acknowledgedRunIds: [runId] };
    });
    const transport: AgentTransport = { checkIn };

    const buildLocalJobs = (): LocalJobReport[] => [];
    const buildRunReports = (): RunReport[] => pendingReports(dir);
    const onAcknowledged = (runIds: string[]): void => acknowledge(dir, runIds);

    const loop = new CheckInLoop({
      transport,
      agentVersion: "1.0.0",
      logger,
      buildLocalJobs,
      buildRunReports,
      onSuccess: (response) => onAcknowledged(response.acknowledgedRunIds ?? []),
      initialDelayMs: 1_000,
      maxDelayMs: 60_000,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(checkIn).toHaveBeenCalledTimes(1);
    expect(checkIn.mock.calls[0]![0]).toMatchObject({ runReports: [expect.objectContaining({ runId, jobId: "job-1" })] });
    // Still queued — the failed check-in's response was never acknowledged.
    expect(pendingReports(dir).map((r) => r.runId)).toContain(runId);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(checkIn).toHaveBeenCalledTimes(2);
    expect(checkIn.mock.calls[1]![0]).toMatchObject({ runReports: [expect.objectContaining({ runId })] });
    expect(pendingReports(dir).map((r) => r.runId)).toContain(runId);

    // Platform comes back up — the next attempt succeeds and acknowledges.
    fail = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(checkIn).toHaveBeenCalledTimes(3);
    expect(pendingReports(dir)).toHaveLength(0);

    await loop.stop();
  });
});
