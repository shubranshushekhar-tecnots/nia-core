import { defaultHomeDir } from "../config/paths.js";
import * as runReportOutbox from "../link/runReportOutbox.js";
import type { Logger } from "./logger.js";
import { isPauseKind, pauseJobState, recordJobFailure, recordJobSuccess } from "./state.js";
import type { RunSyncFailureKind } from "../sync/runSync.js";

/**
 * Slice L4: the single entry point for turning one job run's outcome
 * into (a) the existing job-state bookkeeping (ops/state.ts — unchanged
 * behavior, just centralized) and (b) a run-report outbox entry (B.7).
 * Shared by both call sites that produce a run outcome today —
 * scheduler/jobScheduler.ts's `executeWithRetry` (scheduled/realtime
 * ticks) and index.ts's `job run` CLI handler (manual runs) — so the
 * success/pause/fail decision is never duplicated between them.
 *
 * Confirmed invariant, deliberately preserved: a successful run never
 * clears a pause — `recordJobSuccess` only ever touches
 * `lastSuccessAt`/`lastResult`/`lastError`/`consecutiveFailures`/
 * `rowsSent`/`durationMs`, never `state.paused`. The only place a pause
 * is ever cleared is `job resume` (cli/jobCommands.ts's call to
 * `resumeJobState`). This function must never call `resumeJobState`.
 */
export type RecordableOutcome =
  | { ok: true; rowsSent: number; durationMs: number; rowsDeleted?: number; parts?: number; mode?: string; empty?: boolean }
  | { ok: false; kind: RunSyncFailureKind; error: string; consoleMessage?: string };

export interface RecordRunOutcomeOptions {
  /** `job.pollIntervalSeconds !== undefined` at the call site — routes the run report into the 5-minute realtime aggregator instead of appending immediately. */
  isRealtime: boolean;
  logger?: Logger;
}

export function recordRunOutcome(
  jobId: string,
  outcome: RecordableOutcome,
  startedAt: string,
  options: RecordRunOutcomeOptions,
  dir = defaultHomeDir(),
): void {
  const finishedAt = new Date().toISOString();

  if (outcome.ok) {
    recordJobSuccess(jobId, { rowsSent: outcome.rowsSent, durationMs: outcome.durationMs }, dir);
    runReportOutbox.recordRun(
      dir,
      {
        jobId,
        mode: outcome.mode,
        startedAt,
        finishedAt,
        status: "ok",
        rowsSent: outcome.rowsSent,
        rowsDeleted: outcome.rowsDeleted ?? 0,
        parts: outcome.parts ?? 0,
        isRealtime: options.isRealtime,
        empty: outcome.empty,
      },
      options.logger,
    );
    return;
  }

  // "aborted" and "lockTaken" are handled by the caller before reaching here (neither is a terminal success/fail outcome worth recording as a run).
  recordJobFailure(jobId, { errorClass: outcome.kind, message: outcome.error, consoleMessage: outcome.consoleMessage }, dir);
  if (isPauseKind(outcome.kind)) {
    pauseJobState(jobId, outcome.error, dir);
  }
  runReportOutbox.recordRun(
    dir,
    {
      jobId,
      startedAt,
      finishedAt,
      status: "failed",
      rowsSent: 0,
      rowsDeleted: 0,
      parts: 0,
      errorClass: outcome.kind,
      isRealtime: options.isRealtime,
    },
    options.logger,
  );
}
