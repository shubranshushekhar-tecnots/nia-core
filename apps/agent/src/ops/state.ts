import fs from "node:fs";
import path from "node:path";
import { defaultHomeDir, jobStateDir, stateFilePath } from "../config/paths.js";

/**
 * v4 migration slice B2 (docs/plans/planometry-v4-migration.md §8, §10
 * (B2)): state moved from per-connection to per-job, one JSON file per
 * job under `jobStateDir()`, written atomically (temp file + rename —
 * POSIX rename is atomic, so a reader never observes a half-written
 * file) by both the running scheduler and a manual `job run`. Never
 * holds row data or secrets. `lastConsoleMessage` (a Planometry 400's
 * raw server text) is the one field that's allowed to hold free-form
 * server text — it must never be copied into the log file or the
 * monitoring webhook payload (ops/monitoringHeartbeat.ts), only read
 * back here and by `agent status`.
 */
export type JobRunResult = "completed" | "failed" | "skipped";

export interface JobErrorInfo {
  /** A RunSyncFailureKind (sync/runSync.ts) or "other" — never a raw server message. */
  class: string;
  message: string;
  at: string;
}

export interface JobPauseInfo {
  reason: string;
  at: string;
}

export interface JobState {
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastResult?: JobRunResult;
  lastError?: JobErrorInfo;
  /** A Planometry 400's raw console message, if the last run failed with one. Console/state-file only — see module doc. */
  lastConsoleMessage?: string;
  consecutiveFailures: number;
  paused?: JobPauseInfo;
  nextRunAt?: string;
  rowsSent?: number;
  durationMs?: number;
}

function emptyJobState(): JobState {
  return { consecutiveFailures: 0 };
}

function encodeJobId(jobId: string): string {
  return Buffer.from(jobId, "utf8").toString("base64url");
}

function decodeJobId(encoded: string): string {
  return Buffer.from(encoded, "base64url").toString("utf8");
}

function jobStateFilePath(jobId: string, dir: string): string {
  return path.join(jobStateDir(dir), `${encodeJobId(jobId)}.json`);
}

/** Atomic write: write to a temp file in the same directory, then rename over the real path. */
function writeFileAtomic(file: string, contents: string): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readJobState(jobId: string, dir = defaultHomeDir()): JobState {
  const file = jobStateFilePath(jobId, dir);
  if (!fs.existsSync(file)) return emptyJobState();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<JobState>;
    return { ...emptyJobState(), ...parsed };
  } catch {
    return emptyJobState();
  }
}

export function writeJobState(jobId: string, state: JobState, dir = defaultHomeDir()): void {
  fs.mkdirSync(jobStateDir(dir), { recursive: true, mode: 0o700 });
  writeFileAtomic(jobStateFilePath(jobId, dir), JSON.stringify(state, null, 2));
}

/** Every job id with a state file on disk — used by `agent status`/the monitoring heartbeat to enumerate jobs without needing the config. */
export function listJobStateIds(dir = defaultHomeDir()): string[] {
  const stateDir = jobStateDir(dir);
  if (!fs.existsSync(stateDir)) return [];
  return fs
    .readdirSync(stateDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => decodeJobId(f.slice(0, -".json".length)));
}

export function recordJobRunStarted(jobId: string, dir = defaultHomeDir()): void {
  const state = readJobState(jobId, dir);
  state.lastRunAt = new Date().toISOString();
  writeJobState(jobId, state, dir);
}

export interface RecordJobSuccessInput {
  rowsSent: number;
  durationMs: number;
}

export function recordJobSuccess(jobId: string, input: RecordJobSuccessInput, dir = defaultHomeDir()): void {
  const state = readJobState(jobId, dir);
  state.lastSuccessAt = new Date().toISOString();
  state.lastResult = "completed";
  state.lastError = undefined;
  state.lastConsoleMessage = undefined;
  state.consecutiveFailures = 0;
  state.rowsSent = input.rowsSent;
  state.durationMs = input.durationMs;
  writeJobState(jobId, state, dir);
}

export interface RecordJobFailureInput {
  errorClass: string;
  message: string;
  /** A Planometry 400's raw server text, if any — never logged, never webhooked (see module doc). */
  consoleMessage?: string;
}

/** Returns the job's new consecutive-failure count, so callers can decide whether to escalate without a second read. */
export function recordJobFailure(jobId: string, input: RecordJobFailureInput, dir = defaultHomeDir()): number {
  const state = readJobState(jobId, dir);
  const consecutiveFailures = (state.consecutiveFailures ?? 0) + 1;
  state.lastResult = "failed";
  state.lastError = { class: input.errorClass, message: input.message, at: new Date().toISOString() };
  state.lastConsoleMessage = input.consoleMessage;
  state.consecutiveFailures = consecutiveFailures;
  writeJobState(jobId, state, dir);
  return consecutiveFailures;
}

export function recordJobSkipped(jobId: string, dir = defaultHomeDir()): void {
  const state = readJobState(jobId, dir);
  state.lastResult = "skipped";
  writeJobState(jobId, state, dir);
}

export function recordNextRunAt(jobId: string, nextRunAt: Date | undefined, dir = defaultHomeDir()): void {
  const state = readJobState(jobId, dir);
  state.nextRunAt = nextRunAt?.toISOString();
  writeJobState(jobId, state, dir);
}

export function pauseJobState(jobId: string, reason: string, dir = defaultHomeDir()): void {
  const state = readJobState(jobId, dir);
  state.paused = { reason, at: new Date().toISOString() };
  writeJobState(jobId, state, dir);
}

export function resumeJobState(jobId: string, dir = defaultHomeDir()): void {
  const state = readJobState(jobId, dir);
  state.paused = undefined;
  writeJobState(jobId, state, dir);
}

export function isJobPaused(jobId: string, dir = defaultHomeDir()): boolean {
  return readJobState(jobId, dir).paused !== undefined;
}

export type JobHealth = "ok" | "failing" | "paused";

export function jobHealthState(state: JobState): JobHealth {
  if (state.paused) return "paused";
  if ((state.consecutiveFailures ?? 0) > 0) return "failing";
  return "ok";
}

/** Top-level agent state (just `startedAt` now — per-connection/per-job fields moved to the per-job files above). */
export interface AgentState {
  startedAt?: string;
}

function emptyState(): AgentState {
  return {};
}

export function readState(dir = defaultHomeDir()): AgentState {
  const file = stateFilePath(dir);
  if (!fs.existsSync(file)) return emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<AgentState>;
    return { startedAt: parsed.startedAt };
  } catch {
    return emptyState();
  }
}

export function writeState(state: AgentState, dir = defaultHomeDir()): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(stateFilePath(dir), JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function recordAgentStarted(dir = defaultHomeDir()): void {
  const state = readState(dir);
  state.startedAt = new Date().toISOString();
  writeState(state, dir);
}

export interface StatusReport {
  startedAt?: string;
  uptimeSeconds?: number;
  /** Keyed by job id — every job with a state file on disk, whether or not it's still in the current config. */
  jobs: Record<string, JobState>;
}

export function getStatus(dir = defaultHomeDir()): StatusReport {
  const state = readState(dir);
  const uptimeSeconds = state.startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(state.startedAt)) / 1000)) : undefined;
  const jobs: Record<string, JobState> = {};
  for (const id of listJobStateIds(dir)) jobs[id] = readJobState(id, dir);
  return { startedAt: state.startedAt, uptimeSeconds, jobs };
}
