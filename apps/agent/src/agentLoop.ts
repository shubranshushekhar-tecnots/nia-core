import { defaultHomeDir, defaultLogDir } from "./config/paths.js";
import { loadConfig } from "./config/store.js";
import { Logger } from "./ops/logger.js";
import { buildMonitoringHeartbeatPayload, MonitoringHeartbeatScheduler } from "./ops/monitoringHeartbeat.js";
import { recordAgentStarted, readState } from "./ops/state.js";

export interface AgentLoopOptions {
  dir?: string;
  agentVersion: string;
  signal: AbortSignal;
  logger?: Logger;
}

/**
 * Top-level orchestrator. Cut back for the v4 migration's slice A1
 * (docs/plans/planometry-v4-migration.md §10): the old per-connection
 * poll/sync pipeline was built entirely on the now-deleted work-queue
 * wire protocol (planometry/{pollLoop,catalogSync,heartbeatScheduler}.ts).
 * Until A2+ rebuild that pipeline on the v4 push client, this just loads
 * config, runs the monitoring heartbeat, and idles until `signal` aborts
 * — `nia-agent start` with no jobs idles and stops cleanly on abort.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<void> {
  const dir = options.dir ?? defaultHomeDir();
  const logger = options.logger ?? new Logger(defaultLogDir(dir));
  recordAgentStarted(dir);

  const config = loadConfig(dir);

  const monitoring = new MonitoringHeartbeatScheduler(
    config.monitoring?.heartbeatUrl,
    config.monitoring?.intervalSeconds,
    () => buildMonitoringHeartbeatPayload(options.agentVersion, readState(dir)),
    (err) => logger.warn("monitoring_heartbeat_failed", { error: err instanceof Error ? err.message : String(err) }),
  );
  monitoring.start();
  logger.warn("idle_no_jobs", {});

  try {
    await new Promise<void>((resolve) => {
      if (options.signal.aborted) {
        resolve();
        return;
      }
      options.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    monitoring.stop();
  }
}
