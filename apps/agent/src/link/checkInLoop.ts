import os from "node:os";
import type { Logger } from "../ops/logger.js";
import type { LocalJobReport } from "./localJobReports.js";
import type { RunReport } from "./runReportOutbox.js";
import {
  LinkRevokedError,
  LinkTransientError,
  type AgentConnectionReport,
  type AgentTask,
  type AgentTransport,
  type CheckInResponse,
} from "./transport.js";

const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 60_000;

export interface CheckInLoopOptions {
  transport: AgentTransport;
  agentVersion: string;
  logger: Logger;
  hostName?: string;
  onSuccess?: (response: CheckInResponse) => void;
  onRevoked?: () => void;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Slice L4 (B.11) — called fresh on every check-in so a job added/changed/removed between check-ins is always reported current. */
  buildLocalJobs?: () => LocalJobReport[];
  /** Slice L4 (B.7) — called fresh on every check-in to collect the current outbox contents (also flushes any overdue realtime bucket). */
  buildRunReports?: () => RunReport[];
  /** Slice C1 — called fresh on every check-in so a connection added/changed/removed between check-ins is always reported current. */
  buildLocalConnections?: () => AgentConnectionReport[];
  /** Slice C1 — invoked with every task delivered on a successful check-in, in addition to (not instead of) `onSuccess`. */
  onTasks?: (tasks: AgentTask[]) => void;
}

/**
 * Slice L2 (docs/plans/agent-canvas-integration.md B.3/B.4/B.12): runs
 * entirely independently of scheduler/jobScheduler.ts — a link failure of
 * any kind must never stop or delay a job, so this loop owns its own
 * timer/abort lifecycle and only ever talks to the rest of the agent
 * through the onSuccess/onRevoked callbacks.
 *
 * Backoff: starts at `initialDelayMs` (default 1s), doubles on every
 * LinkTransientError up to `maxDelayMs` (default 60s), and resets to
 * `initialDelayMs` on the next success — "retry with growing delays up to
 * 60 seconds, forever" (B.4). A success re-ticks immediately (delay 0);
 * the bridge's own ~25s long-poll hold is the natural throttle there.
 *
 * A 401 (LinkRevokedError) stops the loop permanently, logs exactly once,
 * and calls `onRevoked` — the loop never ticks again after that (B.12:
 * "every subsequent check-in is rejected immediately", so retrying would
 * just spam 401s).
 */
export class CheckInLoop {
  private readonly hostName: string;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private delayMs: number;
  private timer?: ReturnType<typeof setTimeout>;
  private abortController?: AbortController;
  private stopped = true;
  private revoked = false;
  private inFlight?: Promise<void>;
  private firstCheckIn = true;

  constructor(private readonly options: CheckInLoopOptions) {
    this.hostName = options.hostName ?? os.hostname();
    this.initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.delayMs = this.initialDelayMs;
  }

  start(): void {
    this.stopped = false;
    this.tick();
  }

  /** Interrupt (B.4): stops cleanly — aborts any in-flight check-in and awaits its settlement before resolving, same contract as JobScheduler.stop(). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.abortController?.abort();
    if (this.inFlight) await this.inFlight.catch(() => {});
  }

  private tick(): void {
    if (this.stopped || this.revoked) return;
    const abortController = new AbortController();
    this.abortController = abortController;
    const promise = this.checkInOnce(abortController.signal).finally(() => {
      this.abortController = undefined;
    });
    this.inFlight = promise;
  }

  private async checkInOnce(signal: AbortSignal): Promise<void> {
    // Only the very first check-in after start() asks the bridge to skip
    // its hold (B item 1a) — every later one (including a retry of this
    // same first attempt) holds as before, so flip the flag now, before
    // the request goes out, not inside the success branch below.
    const noHold = this.firstCheckIn;
    this.firstCheckIn = false;
    try {
      const localJobs = this.options.buildLocalJobs?.();
      const runReports = this.options.buildRunReports?.();
      const agentConnections = this.options.buildLocalConnections?.();
      const response = await this.options.transport.checkIn(
        {
          agentVersion: this.options.agentVersion,
          hostName: this.hostName,
          ...(noHold ? { noHold: true } : {}),
          ...(localJobs !== undefined ? { localJobs } : {}),
          ...(runReports !== undefined ? { runReports } : {}),
          ...(agentConnections !== undefined ? { agentConnections } : {}),
        },
        signal,
      );
      if (this.stopped) return;
      this.delayMs = this.initialDelayMs;
      this.options.onSuccess?.(response);
      if (response.tasks.length > 0) this.options.onTasks?.(response.tasks);
      this.scheduleNext(0);
    } catch (err) {
      if (this.stopped) return;
      if (err instanceof LinkRevokedError) {
        this.revoked = true;
        this.options.logger.warn("link_revoked", {});
        this.options.onRevoked?.();
        return;
      }
      if (signal.aborted) return;
      const message = err instanceof LinkTransientError ? err.message : err instanceof Error ? err.message : String(err);
      this.options.logger.warn("link_check_in_failed", { error: message });
      const delay = this.delayMs;
      this.delayMs = Math.min(this.delayMs * 2, this.maxDelayMs);
      this.scheduleNext(delay);
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped || this.revoked) return;
    this.timer = setTimeout(() => this.tick(), delayMs);
  }
}
