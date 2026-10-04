import { request } from "undici";
import { jobHealthState, type JobState } from "./state.js";

/**
 * Optional monitoring heartbeat (Phase 3b §3: "an optional heartbeat to a
 * configurable URL... off by default, no customer data — only agent
 * version, connection ids, last-success times, error counts"). Distinct
 * from planometry/heartbeatScheduler.ts, which reports run liveness to
 * Planometry itself mid-sync — this reports agent health to Nia staff,
 * independent of whether a sync is in progress.
 *
 * Rewritten per-job for the v4 migration's slice B2 (docs/plans/
 * planometry-v4-migration.md §8, §10 (B2), item 5): the payload is
 * built field-by-field from JobState rather than spread, so nothing
 * beyond the fields named here (id, name, health state, error *class*,
 * consecutive failures, times) can ever reach the wire — in particular
 * a Planometry 400's raw console message (JobState.lastConsoleMessage)
 * never does, even if a future field is added to JobState that
 * shouldn't be exported.
 */
export interface JobHeartbeatEntry {
  id: string;
  name: string;
  state: "ok" | "failing" | "paused";
  errorClass?: string;
  consecutiveFailures: number;
  lastRunAt?: string;
  lastSuccessAt?: string;
  nextRunAt?: string;
}

export interface MonitoringHeartbeatPayload {
  agentVersion: string;
  reportedAt: string;
  jobs: JobHeartbeatEntry[];
}

export interface JobHeartbeatSource {
  id: string;
  name: string;
  state: JobState;
}

export function buildMonitoringHeartbeatPayload(agentVersion: string, jobs: JobHeartbeatSource[]): MonitoringHeartbeatPayload {
  return {
    agentVersion,
    reportedAt: new Date().toISOString(),
    jobs: jobs.map(({ id, name, state }) => ({
      id,
      name,
      state: jobHealthState(state),
      errorClass: state.lastError?.class,
      consecutiveFailures: state.consecutiveFailures ?? 0,
      lastRunAt: state.lastRunAt,
      lastSuccessAt: state.lastSuccessAt,
      nextRunAt: state.nextRunAt,
    })),
  };
}

export async function sendMonitoringHeartbeat(heartbeatUrl: string, payload: MonitoringHeartbeatPayload): Promise<void> {
  await request(heartbeatUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

const DEFAULT_INTERVAL_SECONDS = 300;

/**
 * No-op scheduler when `heartbeatUrl` is unset — callers can construct
 * and `start()` this unconditionally without an if-configured branch at
 * every call site. Send failures are swallowed (best-effort monitoring
 * signal, never allowed to affect sync operation).
 */
export class MonitoringHeartbeatScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly heartbeatUrl: string | undefined,
    private readonly intervalSeconds: number | undefined,
    private readonly getPayload: () => MonitoringHeartbeatPayload,
    private readonly onError?: (err: unknown) => void,
    /** Injectable for tests — defaults to the real network send. */
    private readonly send: (url: string, payload: MonitoringHeartbeatPayload) => Promise<void> = sendMonitoringHeartbeat,
  ) {}

  start(): void {
    if (!this.heartbeatUrl) return;
    const url = this.heartbeatUrl;
    const intervalMs = (this.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS) * 1000;
    this.timer = setInterval(() => {
      this.send(url, this.getPayload()).catch((err) => this.onError?.(err));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
