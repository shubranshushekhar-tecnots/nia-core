import type { RunSyncOptions, RunSyncResult } from "../sync/runSync.js";

/**
 * Slice R2 (docs/plans/agent-canvas-integration.md §B.7/§B.10): the common
 * seam `cli/runJobCommand.ts` dispatches a resolved run through, once the
 * source rows/delta/reconciliation/soft-delete inputs are already built.
 * `pushKey`/`tableSemaphore` are excluded — those are Planometry-specific
 * extras `PlanometryDestination` holds itself (constructed once per
 * `runJob` call with the job's resolved push key), not part of the shared
 * contract. `runSync.ts` itself is untouched by this slice; the Planometry
 * destination is a pure pass-through to it.
 */
export type DestinationRunOptions = Omit<RunSyncOptions, "pushKey" | "tableSemaphore">;

export type DestinationRunResult = RunSyncResult;

export interface Destination {
  run(options: DestinationRunOptions): Promise<DestinationRunResult>;
}
