import type { Logger } from "../ops/logger.js";
import { isJobPaused, pauseJobState, readJobState, recordJobFailure, recordJobRunStarted, recordJobSkipped, recordJobSuccess, recordNextRunAt } from "../ops/state.js";
import { Semaphore } from "../sync/concurrency.js";
import type { RunSyncFailureKind } from "../sync/runSync.js";
import { nextOccurrence } from "./cronSchedule.js";

/**
 * v4 migration slice B2 (docs/plans/planometry-v4-migration.md §8, §10
 * (B2)): runs every scheduled job on its own timer, isolated from every
 * other job's failures — one job throwing, retrying, or pausing never
 * stops the loop or any other job. `runJob`/`loadJobs`/`now` are all
 * injected so this class has no SQL Server/Planometry/real-clock
 * dependency of its own; the real wiring (agentLoop.ts) supplies a
 * `runJob` that calls cli/runJobCommand.ts's `runJob` and translates its
 * `RunJobOutcome` into a `SchedulerJobOutcome`.
 */
export interface SchedulerJob {
  id: string;
  name: string;
  connectionId: string;
  /** 5-field cron expression. Unset: never scheduled, only run via `job run`. */
  schedule?: string;
  /** A separate 5-field cron expression for a periodic full `replace`, independent of `schedule`'s delta cadence (plan §2, §8, §10 slice C1) — `upsertDelta` jobs only. Unset: no periodic forced replace. */
  replaceSchedule?: string;
  /** IANA time zone both `schedule` and `replaceSchedule` are evaluated in — the job's connection's sourceTimeZone. */
  timeZone: string;
}

export type SchedulerJobOutcome =
  | { ok: true; rowsSent: number; durationMs: number }
  | {
      ok: false;
      kind: RunSyncFailureKind;
      /** Safe to log — never a raw server message. */
      error: string;
      /** A Planometry 400's raw server text, if any. Never logged, never webhooked — ops/state.ts's module doc. */
      consoleMessage?: string;
    };

/** §10(B2) item 3: these — and only these — pause a job until `job resume`. */
const PAUSE_KINDS: ReadonlySet<RunSyncFailureKind> = new Set(["config", "schemaDrift", "typeMismatch", "nullKey", "massDelete"]);
/** §10(B2) item 2: these retry with backoff instead of pausing or waiting for the next tick. */
const RETRY_KINDS: ReadonlySet<RunSyncFailureKind> = new Set(["transient", "diskSpace"]);
/** 1, 5, 15 minutes. */
const DEFAULT_RETRY_DELAYS_MS = [60_000, 300_000, 900_000];
/** §8: a running service must pick up job add/change/remove within 60s without a restart. */
const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;

export interface JobSchedulerOptions {
  dir: string;
  logger: Logger;
  /** Injectable clock — tests run entirely on fake timers, no real wall-clock waits. */
  now?: () => Date;
  /** How often to re-read `loadJobs()` for added/changed/removed jobs. Defaults to 60s. */
  reconcileIntervalMs?: number;
  /** Re-read on every reconcile — lets a running service see job add/update/remove without restarting. */
  loadJobs: () => SchedulerJob[];
  /** Runs one job to completion. `forceReplace` is true for a `replaceSchedule` tick (periodic forced full replace) — same meaning as `job run --replace`. */
  runJob: (job: SchedulerJob, signal: AbortSignal, forceReplace: boolean) => Promise<SchedulerJobOutcome>;
  /** Global cap on simultaneously running jobs, queued (not refused) past the limit. Default 1. */
  maxConcurrentRuns?: number;
  /** Backoff delays for "transient"/"diskSpace" failures, in order. Defaults to 1/5/15 min. */
  retryDelaysMs?: number[];
}

interface JobRuntime {
  job: SchedulerJob;
  timer?: ReturnType<typeof setTimeout>;
  /** Independent timer for `job.replaceSchedule` — armed/cleared separately from `timer`. */
  replaceTimer?: ReturnType<typeof setTimeout>;
  running: boolean;
  abortController?: AbortController;
}

export class JobScheduler {
  private readonly runtimes = new Map<string, JobRuntime>();
  private readonly now: () => Date;
  private readonly reconcileIntervalMs: number;
  private readonly semaphore: Semaphore;
  private readonly retryDelaysMs: number[];
  private readonly inFlight = new Set<Promise<void>>();
  private reconcileTimer?: ReturnType<typeof setInterval>;
  private stopped = true;

  constructor(private readonly options: JobSchedulerOptions) {
    this.now = options.now ?? (() => new Date());
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
    this.semaphore = new Semaphore(options.maxConcurrentRuns ?? 1);
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  /**
   * Loads jobs immediately (scheduling any due/missed run once), then
   * reconciles on a timer. Deliberately left ref'd (not `.unref()`'d):
   * this timer always exists, with or without jobs, and is the thing
   * that keeps `agent start` resident — it's cleared in `stop()`, which
   * agentLoop.ts calls once the service is told to shut down. An
   * unref'd timer here let the whole process exit the instant there
   * was no other pending I/O, instead of idling until the next
   * reconcile/tick or an interrupt (found during Phase B's real-run
   * verification — `agent start` was returning almost immediately).
   */
  start(): void {
    this.stopped = false;
    this.reconcile();
    this.reconcileTimer = setInterval(() => this.reconcile(), this.reconcileIntervalMs);
  }

  /** Clears every timer, aborts every in-flight run, and resolves once they've all settled. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = undefined;
    for (const runtime of this.runtimes.values()) {
      if (runtime.timer) clearTimeout(runtime.timer);
      runtime.timer = undefined;
      if (runtime.replaceTimer) clearTimeout(runtime.replaceTimer);
      runtime.replaceTimer = undefined;
      runtime.abortController?.abort();
    }
    await Promise.allSettled([...this.inFlight]);
  }

  /**
   * Diffs `loadJobs()` against the known runtimes by job id. New jobs are
   * scheduled (running a missed tick immediately if its persisted
   * `nextRunAt` is already due — a run missed while the agent was down,
   * fired once, never backfilled per-tick). Jobs whose schedule/timezone
   * changed are rescheduled fresh from now. Removed jobs have their timer
   * cleared; an in-flight run, if any, is left alone to finish on its own.
   */
  private reconcile(): void {
    if (this.stopped) return;
    const jobs = this.options.loadJobs();
    const seen = new Set<string>();

    for (const job of jobs) {
      seen.add(job.id);
      const existing = this.runtimes.get(job.id);
      if (!existing) {
        const runtime: JobRuntime = { job, running: false };
        this.runtimes.set(job.id, runtime);
        this.scheduleNewRuntime(runtime);
        continue;
      }
      const scheduleChanged = existing.job.schedule !== job.schedule || existing.job.timeZone !== job.timeZone;
      const replaceScheduleChanged = existing.job.replaceSchedule !== job.replaceSchedule || existing.job.timeZone !== job.timeZone;
      existing.job = job;
      if (scheduleChanged) {
        if (existing.timer) clearTimeout(existing.timer);
        existing.timer = undefined;
        this.scheduleNext(existing);
      }
      if (replaceScheduleChanged) {
        if (existing.replaceTimer) clearTimeout(existing.replaceTimer);
        existing.replaceTimer = undefined;
        this.scheduleNextReplace(existing);
      }
    }

    for (const [id, runtime] of this.runtimes) {
      if (seen.has(id)) continue;
      if (runtime.timer) clearTimeout(runtime.timer);
      if (runtime.replaceTimer) clearTimeout(runtime.replaceTimer);
      this.runtimes.delete(id);
    }
  }

  /** A brand-new runtime (first seen this process): if its persisted nextRunAt is already due, that's a run missed while the agent was down — run it once now via the normal onTick path, rather than waiting for the next occurrence. `replaceSchedule` has no missed-run catch-up (no persisted state of its own) — it's simply armed fresh from now. */
  private scheduleNewRuntime(runtime: JobRuntime): void {
    if (runtime.job.schedule) this.scheduleNewScheduleRuntime(runtime);
    this.scheduleNextReplace(runtime);
  }

  private scheduleNewScheduleRuntime(runtime: JobRuntime): void {
    const persistedNextRunAt = readJobState(runtime.job.id, this.options.dir).nextRunAt;
    const isMissed = persistedNextRunAt !== undefined && new Date(persistedNextRunAt).getTime() <= this.now().getTime();
    if (isMissed) {
      this.onTick(runtime).catch((err) => this.logTickError(runtime, err));
      return;
    }
    this.scheduleNext(runtime);
  }

  /**
   * Computes and persists the next future occurrence from now, and arms
   * a timer for it. Also deliberately ref'd — see `start()`'s comment —
   * so a scheduled job's pending tick genuinely keeps the process alive
   * until it fires, instead of letting the process exit from under it.
   */
  private scheduleNext(runtime: JobRuntime): void {
    if (!runtime.job.schedule || this.stopped) return;
    if (runtime.timer) clearTimeout(runtime.timer);
    const next = nextOccurrence(runtime.job.schedule, runtime.job.timeZone, this.now());
    recordNextRunAt(runtime.job.id, next, this.options.dir);
    const delayMs = Math.max(0, next.getTime() - this.now().getTime());
    runtime.timer = setTimeout(() => {
      this.onTick(runtime).catch((err) => this.logTickError(runtime, err));
    }, delayMs);
  }

  private logTickError(runtime: JobRuntime, err: unknown): void {
    this.options.logger.error("job_tick_threw", { jobId: runtime.job.id, error: err instanceof Error ? err.message : String(err) });
  }

  /**
   * `replaceSchedule`'s own independent timer (plan §2/§5/§10 slice C1) —
   * mirrors `scheduleNext`, but for the separate periodic-full-replace
   * cadence. No persisted `nextRunAt`-style state of its own, so no
   * missed-run catch-up: a `replaceSchedule` tick missed while the agent
   * was down simply waits for its next occurrence.
   */
  private scheduleNextReplace(runtime: JobRuntime): void {
    if (!runtime.job.replaceSchedule || this.stopped) return;
    if (runtime.replaceTimer) clearTimeout(runtime.replaceTimer);
    const next = nextOccurrence(runtime.job.replaceSchedule, runtime.job.timeZone, this.now());
    const delayMs = Math.max(0, next.getTime() - this.now().getTime());
    runtime.replaceTimer = setTimeout(() => {
      this.onReplaceTick(runtime).catch((err) => this.logTickError(runtime, err));
    }, delayMs);
  }

  /**
   * Fires when a job's timer elapses (or a missed run is caught up at
   * startup). Always re-arms the *next* occurrence first, independent of
   * how long this tick's run takes — ticks happen on a fixed cron
   * cadence, so a run that outlives its own interval doesn't delay or
   * skip the schedule itself; only this tick's execution is skipped (and
   * logged) if the job is paused or a previous run is still in flight.
   */
  private async onTick(runtime: JobRuntime): Promise<void> {
    if (this.stopped) return;
    this.scheduleNext(runtime);
    const { job } = runtime;
    const dir = this.options.dir;

    if (isJobPaused(job.id, dir)) {
      recordJobSkipped(job.id, dir);
      this.options.logger.warn("job_tick_skipped_paused", { jobId: job.id });
      return;
    }

    if (runtime.running) {
      recordJobSkipped(job.id, dir);
      this.options.logger.warn("job_tick_skipped_running", { jobId: job.id });
      return;
    }

    await this.fire(runtime, false);
  }

  /** `replaceSchedule`'s tick — same pause/in-flight checks as `onTick`, but always fires a forced-replace run, independently of `schedule`'s own timer/state. */
  private async onReplaceTick(runtime: JobRuntime): Promise<void> {
    if (this.stopped) return;
    this.scheduleNextReplace(runtime);
    const { job } = runtime;
    const dir = this.options.dir;

    if (isJobPaused(job.id, dir)) {
      recordJobSkipped(job.id, dir);
      this.options.logger.warn("job_replace_tick_skipped_paused", { jobId: job.id });
      return;
    }

    if (runtime.running) {
      recordJobSkipped(job.id, dir);
      this.options.logger.warn("job_replace_tick_skipped_running", { jobId: job.id });
      return;
    }

    await this.fire(runtime, true);
  }

  /** Runs the job through the global concurrency semaphore + retry logic — isolated via catch so one job's throw can never escape to the scheduler or another job. `forceReplace` is true for a `replaceSchedule` tick. */
  private fire(runtime: JobRuntime, forceReplace: boolean): Promise<void> {
    runtime.running = true;
    const abortController = new AbortController();
    runtime.abortController = abortController;

    const promise: Promise<void> = this.executeOnce(runtime, abortController.signal, forceReplace)
      .catch((err) => {
        this.options.logger.error("job_run_threw", { jobId: runtime.job.id, error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        runtime.running = false;
        runtime.abortController = undefined;
        this.inFlight.delete(promise);
      });
    this.inFlight.add(promise);
    return promise;
  }

  /** Waits for a global concurrency slot (queued, not refused), then drives the job with retry. */
  private async executeOnce(runtime: JobRuntime, signal: AbortSignal, forceReplace: boolean): Promise<void> {
    const release = await this.semaphore.acquire();
    try {
      await this.executeWithRetry(runtime, signal, forceReplace);
    } finally {
      release();
    }
  }

  /**
   * One job run, retrying "transient"/"diskSpace" failures with backoff
   * (never pausing); pausing on "config"/"schemaDrift"/"typeMismatch"/
   * "nullKey"; skipping-without-failure on "lockTaken"; treating an abort
   * as a clean stop (no failure recorded); and otherwise recording a
   * failure and waiting for the job's next scheduled tick.
   */
  private async executeWithRetry(runtime: JobRuntime, signal: AbortSignal, forceReplace: boolean): Promise<void> {
    const { job } = runtime;
    const dir = this.options.dir;
    let attempt = 0;

    while (true) {
      if (signal.aborted) return;
      recordJobRunStarted(job.id, dir);

      let outcome: SchedulerJobOutcome;
      try {
        outcome = await this.options.runJob(job, signal, forceReplace);
      } catch (err) {
        outcome = { ok: false, kind: "other", error: err instanceof Error ? err.message : String(err) };
      }

      if (outcome.ok) {
        recordJobSuccess(job.id, { rowsSent: outcome.rowsSent, durationMs: outcome.durationMs }, dir);
        this.options.logger.info("job_run_completed", { jobId: job.id, rowsSent: outcome.rowsSent });
        return;
      }

      if (outcome.kind === "aborted") {
        this.options.logger.info("job_run_aborted", { jobId: job.id });
        return;
      }

      if (outcome.kind === "lockTaken") {
        recordJobSkipped(job.id, dir);
        this.options.logger.warn("job_tick_skipped_lock_taken", { jobId: job.id });
        return;
      }

      if (PAUSE_KINDS.has(outcome.kind)) {
        recordJobFailure(job.id, { errorClass: outcome.kind, message: outcome.error, consoleMessage: outcome.consoleMessage }, dir);
        pauseJobState(job.id, outcome.error, dir);
        this.options.logger.warn("job_paused", { jobId: job.id, kind: outcome.kind });
        return;
      }

      if (RETRY_KINDS.has(outcome.kind) && attempt < this.retryDelaysMs.length) {
        this.options.logger.warn("job_run_retrying", { jobId: job.id, kind: outcome.kind, attempt: attempt + 1 });
        await this.sleep(this.retryDelaysMs[attempt]!, signal);
        attempt += 1;
        if (signal.aborted) return;
        continue;
      }

      recordJobFailure(job.id, { errorClass: outcome.kind, message: outcome.error, consoleMessage: outcome.consoleMessage }, dir);
      this.options.logger.warn("job_run_failed", { jobId: job.id, kind: outcome.kind, error: outcome.error });
      return;
    }
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
