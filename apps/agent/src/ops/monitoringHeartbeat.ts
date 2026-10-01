import { request } from "undici";
import type { AgentState } from "./state.js";

/**
 * Optional monitoring heartbeat (Phase 3b §3: "an optional heartbeat to a
 * configurable URL... off by default, no customer data — only agent
 * version, connection ids, last-success times, error counts"). Distinct
 * from planometry/heartbeatScheduler.ts, which reports run liveness to
 * Planometry itself mid-sync — this reports agent health to Nia staff,
 * independent of whether a sync is in progress.
 *
 * The payload shape below is the enforcement point for "no customer
 * data": it's built field-by-field from AgentState rather than spread,
 * so nothing on ConnectionState beyond the four fields named here can
 * ever reach the wire, even if a future field is added to AgentState
 * that shouldn't be exported (e.g. anything row-derived).
 */
export interface MonitoringHeartbeatPayload {
  agentVersion: string;
  reportedAt: string;
  connections: Array<{
    id: string;
    lastSyncAt?: string;
    lastPollAt?: string;
    errorCount: number;
  }>;
}

export function buildMonitoringHeartbeatPayload(agentVersion: string, state: AgentState): MonitoringHeartbeatPayload {
  return {
    agentVersion,
    reportedAt: new Date().toISOString(),
    connections: Object.entries(state.connections).map(([id, c]) => ({
      id,
      lastSyncAt: c.lastSyncAt,
      lastPollAt: c.lastPollAt,
      errorCount: c.consecutiveFailures ?? 0,
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
