import { defaultHomeDir } from "../config/paths.js";
import { loadConfig } from "../config/store.js";
import { jobHealthState, readJobState, type JobHealth } from "../ops/state.js";

/**
 * Slice L4 (docs/plans/agent-canvas-integration.md B.11): the per-check-in
 * summary of every locally-defined job, read-only on the Agents page.
 * Exactly these fields travel to the platform (the allow-list the
 * bridge's zod schema also enforces) — never a row value, filter/param
 * value, or Planometry rejection message (`state.lastConsoleMessage`,
 * `state.lastError.message` are deliberately excluded).
 */
export interface LocalJobReport {
  id: string;
  name: string;
  connectionName: string;
  sourceTable: string;
  destinationType: string;
  destinationHost: string;
  mode: string;
  schedule?: string;
  state: JobHealth;
  errorClass?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  consecutiveFailures: number;
}

function destinationFromTargetUrl(targetUrl: string): { destinationType: string; destinationHost: string } {
  try {
    const url = new URL(targetUrl);
    return { destinationType: url.protocol.replace(/:$/, ""), destinationHost: url.host };
  } catch {
    return { destinationType: "unknown", destinationHost: "unknown" };
  }
}

export function buildLocalJobReports(dir = defaultHomeDir()): LocalJobReport[] {
  const config = loadConfig(dir);
  return config.jobs.map((job) => {
    const connection = config.connections.find((c) => c.id === job.connectionId);
    const state = readJobState(job.id, dir);
    const { destinationType, destinationHost } = destinationFromTargetUrl(job.targetUrl);
    return {
      id: job.id,
      name: job.name,
      connectionName: connection?.label ?? "(unknown connection)",
      sourceTable: job.sourceTable,
      destinationType,
      destinationHost,
      mode: job.strategy,
      schedule: job.schedule ?? (job.pollIntervalSeconds !== undefined ? `every ${job.pollIntervalSeconds}s` : undefined),
      state: jobHealthState(state),
      errorClass: state.lastError?.class,
      lastRunAt: state.lastRunAt,
      nextRunAt: state.nextRunAt,
      consecutiveFailures: state.consecutiveFailures,
    };
  });
}
