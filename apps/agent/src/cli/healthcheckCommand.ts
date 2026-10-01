import { defaultHomeDir } from "../config/paths.js";
import { getStatus } from "../ops/state.js";

export interface HealthcheckResult {
  healthy: boolean;
  reason?: string;
}

const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * `nia-agent healthcheck` (Phase 3b §1 — Docker's `HEALTHCHECK CMD`).
 * Runs as a separate, short-lived process invocation alongside the
 * long-running `start` process, so it can only inspect on-disk state —
 * no IPC into the running process. Unhealthy if the agent has never
 * recorded a start, or if any connection's last poll is older than
 * `staleAfterMs` (a generous default — `pollAfterSeconds` is server-
 * controlled, so this only catches a genuinely stuck/crashed loop).
 */
export function runHealthcheck(dir = defaultHomeDir(), staleAfterMs = DEFAULT_STALE_AFTER_MS): HealthcheckResult {
  const status = getStatus(dir);
  if (!status.startedAt) return { healthy: false, reason: "agent has not recorded a start" };

  for (const [id, connection] of Object.entries(status.connections)) {
    if (!connection.lastPollAt) continue;
    const ageMs = Date.now() - Date.parse(connection.lastPollAt);
    if (ageMs > staleAfterMs) {
      return { healthy: false, reason: `connection ${id} has not polled in ${Math.round(ageMs / 1000)}s (threshold ${Math.round(staleAfterMs / 1000)}s)` };
    }
  }

  return { healthy: true };
}
