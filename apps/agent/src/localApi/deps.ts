import type { Logger } from "../ops/logger.js";
import type { WorkflowsClient } from "../link/workflowsClient.js";
import type { JobScheduler } from "../scheduler/jobScheduler.js";

/** Shared across every route builder — one `dir` (the agent's data dir, `NIA_AGENT_HOME`-overridable in tests) and `agentVersion`/`logger` for the few routes that need them. */
export interface LocalApiDeps {
  dir: string;
  agentVersion: string;
  logger: Logger;
  /**
   * Workflows screen (agent app) — `undefined` whenever unpaired or no
   * live link, same "not paired" signal routes/workflows.ts uses to
   * return a clear response instead of erroring. A function (not a
   * plain field) because the underlying client is rebuilt on every
   * pair/unpair cycle (agentLoop.ts's applyLink) — callers must re-read
   * it on every request, never cache the reference.
   */
  getWorkflowsClient?: () => WorkflowsClient | undefined;
  /** The paired platform's base URL, for building "Edit on website" links — same undefined-when-unpaired rule as getWorkflowsClient. */
  getPlatformUrl?: () => string | undefined;
  /** The one process-wide scheduler — routes/workflows.ts reads `isRunning(jobId)` off it for the local-only "running" overlay; never rebuilt, unlike the two accessors above. */
  scheduler?: JobScheduler;
}
