import type { Logger } from "./logger.js";

/**
 * Phase 3b §3: "clear log lines for repeated failures". A single
 * failure logs at `warn`; once the same connection has failed this many
 * times in a row (state.ts's `consecutiveFailures`, reset on the next
 * success), every subsequent failure escalates to `error` with a
 * distinct event name, so an ops dashboard/alert can grep for
 * `repeated_sync_failures` instead of every transient blip.
 */
export const REPEATED_FAILURE_THRESHOLD = 3;

export function logSyncFailure(logger: Logger, connectionId: string, error: string, consecutiveFailures: number): void {
  if (consecutiveFailures >= REPEATED_FAILURE_THRESHOLD) {
    logger.error("repeated_sync_failures", { connectionId, error, consecutiveFailures });
  } else {
    logger.warn("sync_failed", { connectionId, error, consecutiveFailures });
  }
}
