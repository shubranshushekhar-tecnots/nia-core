import { defaultHomeDir } from "../config/paths.js";
import { getStatus } from "../ops/state.js";

export interface HealthcheckResult {
  healthy: boolean;
  reason?: string;
}

/**
 * `nia-agent healthcheck` (Phase 3b §1 — Docker's `HEALTHCHECK CMD`).
 * Runs as a separate, short-lived process invocation alongside the
 * long-running `start` process, so it can only inspect on-disk state —
 * no IPC into the running process. Unhealthy only if the agent has
 * never recorded a start (process liveness); per-job staleness/pause/
 * failure detail is `agent status`'s job (docs/plans/planometry-v4-
 * migration.md §10 (B2) item 4), not this process-liveness check.
 */
export function runHealthcheck(dir = defaultHomeDir()): HealthcheckResult {
  const status = getStatus(dir);
  if (!status.startedAt) return { healthy: false, reason: "agent has not recorded a start" };
  return { healthy: true };
}
