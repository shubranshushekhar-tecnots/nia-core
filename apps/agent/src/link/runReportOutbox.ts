import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { defaultHomeDir, runReportOutboxFilePath } from "../config/paths.js";
import type { Logger } from "../ops/logger.js";

/**
 * Slice L4 (docs/plans/agent-canvas-integration.md B.7): the agent's
 * outbound run-report outbox, isolated from `ops/state.ts`/`ops/
 * linkState.ts` — same "a bookkeeping failure must never touch job
 * execution" principle `linkState.ts`'s header already documents.
 *
 * Exactly these fields travel to the platform (the allow-list the bridge's
 * zod schema also enforces) — never a row value, key value, parameter
 * value, or Planometry rejection message.
 */
export interface RunReport {
  runId: string;
  jobId: string;
  mode?: string;
  startedAt: string;
  finishedAt: string;
  status: "ok" | "failed";
  rowsSent: number;
  rowsDeleted: number;
  parts: number;
  errorClass?: string;
  isRealtimeAggregate?: boolean;
  periodStart?: string;
  periodEnd?: string;
}

export interface RecordRunInput {
  jobId: string;
  mode?: string;
  startedAt: string;
  finishedAt: string;
  status: "ok" | "failed";
  rowsSent: number;
  rowsDeleted: number;
  parts: number;
  errorClass?: string;
  /** `job.pollIntervalSeconds !== undefined` at the call site — a realtime job's ticks are aggregated into a 5-minute bucket instead of appended immediately (B.7). */
  isRealtime: boolean;
  /** Realtime only: true when the tick sent/deleted nothing and didn't fail — dropped entirely, never aggregated ("only when something was sent/failed"). */
  empty?: boolean;
}

const MAX_OUTBOX_SIZE = 500;
const REALTIME_BUCKET_MS = 5 * 60 * 1000;

interface RealtimeBucket {
  periodStart: string;
  finishedAt: string;
  mode?: string;
  rowsSent: number;
  rowsDeleted: number;
  parts: number;
  status: "ok" | "failed";
  errorClass?: string;
}

interface OutboxFile {
  reports: RunReport[];
  /** Keyed by jobId — at most one in-progress realtime bucket per job. */
  buckets: Record<string, RealtimeBucket>;
  droppedCount: number;
}

function emptyOutbox(): OutboxFile {
  return { reports: [], buckets: {}, droppedCount: 0 };
}

/** Atomic write: mirrors ops/state.ts's writeFileAtomic (temp file in the same dir + rename), copied locally rather than imported — same posture as ops/linkState.ts. */
function writeFileAtomic(file: string, contents: string): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readOutbox(dir: string): OutboxFile {
  const file = runReportOutboxFilePath(dir);
  if (!fs.existsSync(file)) return emptyOutbox();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<OutboxFile>;
    return { reports: parsed.reports ?? [], buckets: parsed.buckets ?? {}, droppedCount: parsed.droppedCount ?? 0 };
  } catch {
    return emptyOutbox();
  }
}

function writeOutbox(outbox: OutboxFile, dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(runReportOutboxFilePath(dir), JSON.stringify(outbox, null, 2));
}

/** Appends one report, dropping the oldest unacknowledged entry (and counting it, logged once per drop) when already at MAX_OUTBOX_SIZE. */
function appendReport(outbox: OutboxFile, report: RunReport, logger?: Logger): void {
  if (outbox.reports.length >= MAX_OUTBOX_SIZE) {
    outbox.reports.shift();
    outbox.droppedCount += 1;
    logger?.warn("run_report_outbox_full", { droppedCount: outbox.droppedCount });
  }
  outbox.reports.push(report);
}

/**
 * Flushes every realtime bucket whose periodStart is more than 5 minutes
 * old into the outbox as an aggregate report. Called both when a tick
 * records a run (so a bucket started long ago and never revisited still
 * eventually flushes) and — per Change 5 — whenever reports are collected
 * for a check-in (`pendingReports`), so an overdue bucket is reported
 * promptly even if the job is paused/removed and never ticks again.
 */
function flushStaleBuckets(outbox: OutboxFile, now: number, logger?: Logger): void {
  for (const jobId of Object.keys(outbox.buckets)) {
    const bucket = outbox.buckets[jobId]!;
    if (now - Date.parse(bucket.periodStart) < REALTIME_BUCKET_MS) continue;
    appendReport(
      outbox,
      {
        runId: crypto.randomUUID(),
        jobId,
        mode: bucket.mode,
        startedAt: bucket.periodStart,
        finishedAt: bucket.finishedAt,
        status: bucket.status,
        rowsSent: bucket.rowsSent,
        rowsDeleted: bucket.rowsDeleted,
        parts: bucket.parts,
        errorClass: bucket.errorClass,
        isRealtimeAggregate: true,
        periodStart: bucket.periodStart,
        periodEnd: bucket.finishedAt,
      },
      logger,
    );
    delete outbox.buckets[jobId];
  }
}

/** The single entry point for recording a run outcome, called from both the scheduler and the manual CLI `job run` path (ops/recordRun.ts). */
export function recordRun(dir: string, input: RecordRunInput, logger?: Logger): void {
  const outbox = readOutbox(dir);
  flushStaleBuckets(outbox, Date.now(), logger);

  if (!input.isRealtime) {
    appendReport(
      outbox,
      {
        runId: crypto.randomUUID(),
        jobId: input.jobId,
        mode: input.mode,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        status: input.status,
        rowsSent: input.rowsSent,
        rowsDeleted: input.rowsDeleted,
        parts: input.parts,
        errorClass: input.errorClass,
      },
      logger,
    );
    writeOutbox(outbox, dir);
    return;
  }

  if (input.empty) {
    // Nothing to aggregate this tick — still persist any bucket flushed above.
    writeOutbox(outbox, dir);
    return;
  }

  const existing = outbox.buckets[input.jobId];
  if (!existing) {
    outbox.buckets[input.jobId] = {
      periodStart: input.startedAt,
      finishedAt: input.finishedAt,
      mode: input.mode,
      rowsSent: input.rowsSent,
      rowsDeleted: input.rowsDeleted,
      parts: input.parts,
      status: input.status,
      errorClass: input.errorClass,
    };
  } else {
    existing.rowsSent += input.rowsSent;
    existing.rowsDeleted += input.rowsDeleted;
    existing.parts += input.parts;
    existing.status = input.status;
    existing.errorClass = input.errorClass;
    existing.finishedAt = input.finishedAt;
    existing.mode = input.mode ?? existing.mode;
  }
  writeOutbox(outbox, dir);
}

/**
 * Every un-acknowledged, already-flushed report — called right before a
 * check-in goes out. First flushes any realtime bucket older than 5
 * minutes (Change 5: "at collection time", not only on the next tick), so
 * an overdue aggregate is never stuck behind a job that stops ticking.
 */
export function pendingReports(dir = defaultHomeDir(), logger?: Logger): RunReport[] {
  const outbox = readOutbox(dir);
  const before = JSON.stringify(outbox.buckets);
  flushStaleBuckets(outbox, Date.now(), logger);
  if (JSON.stringify(outbox.buckets) !== before || outbox.reports.length > 0) writeOutbox(outbox, dir);
  return outbox.reports;
}

/** Removes acknowledged entries once the platform's check-in response lists their run ids — a report is kept until acked, per the outbox's idempotency contract (B.7). */
export function acknowledge(dir: string, runIds: string[]): void {
  if (runIds.length === 0) return;
  const outbox = readOutbox(dir);
  const ids = new Set(runIds);
  const next = outbox.reports.filter((r) => !ids.has(r.runId));
  if (next.length === outbox.reports.length) return;
  outbox.reports = next;
  writeOutbox(outbox, dir);
}
