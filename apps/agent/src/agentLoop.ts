import { runJob as runJobCommand } from "./cli/runJobCommand.js";
import { defaultHomeDir, defaultLogDir } from "./config/paths.js";
import { findConnection, loadConfig } from "./config/store.js";
import { Logger } from "./ops/logger.js";
import { buildMonitoringHeartbeatPayload, MonitoringHeartbeatScheduler, type JobHeartbeatSource } from "./ops/monitoringHeartbeat.js";
import { readJobState, recordAgentStarted } from "./ops/state.js";
import { JobScheduler, type SchedulerJob, type SchedulerJobOutcome } from "./scheduler/jobScheduler.js";

export interface AgentLoopOptions {
  dir?: string;
  agentVersion: string;
  signal: AbortSignal;
  logger?: Logger;
}

/**
 * Top-level orchestrator (docs/plans/planometry-v4-migration.md §8, §10
 * (B2)): re-reads `agent.config.json` on every `JobScheduler` reconcile
 * (not just once at startup) so jobs added/changed/removed by the CLI
 * while the service is running are picked up without a restart. Each
 * job runs on its own cron schedule, in its connection's timezone, via
 * `cli/runJobCommand.ts`'s `runJob` — the scheduler isolates one job's
 * failure from every other job and from the loop itself. `nia-agent
 * start` with no scheduled jobs just idles the monitoring heartbeat
 * until `signal` aborts.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<void> {
  const dir = options.dir ?? defaultHomeDir();
  const logger = options.logger ?? new Logger(defaultLogDir(dir));
  recordAgentStarted(dir);

  const scheduler = new JobScheduler({
    dir,
    logger,
    loadJobs: () => loadSchedulerJobs(dir),
    runJob: (job, signal) => runSchedulerJob(job, signal, dir),
    maxConcurrentRuns: loadConfig(dir).maxConcurrentRuns,
  });
  scheduler.start();

  const monitoring = new MonitoringHeartbeatScheduler(
    loadConfig(dir).monitoring?.heartbeatUrl,
    loadConfig(dir).monitoring?.intervalSeconds,
    () => buildMonitoringHeartbeatPayload(options.agentVersion, loadJobHeartbeatSources(dir)),
    (err) => logger.warn("monitoring_heartbeat_failed", { error: err instanceof Error ? err.message : String(err) }),
  );
  monitoring.start();

  if (loadConfig(dir).jobs.length === 0) logger.warn("idle_no_jobs", {});

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
    await scheduler.stop();
  }
}

/** Every job whose connection still exists, as of the current config on disk. A job referencing a since-deleted connection is skipped (defensive — `job remove`/`connection remove` shouldn't leave that state). */
function loadSchedulerJobs(dir: string): SchedulerJob[] {
  const config = loadConfig(dir);
  const jobs: SchedulerJob[] = [];
  for (const job of config.jobs) {
    const connection = findConnection(config, job.connectionId);
    if (!connection) continue;
    jobs.push({ id: job.id, name: job.name, connectionId: job.connectionId, schedule: job.schedule, timeZone: connection.sourceTimeZone });
  }
  return jobs;
}

function loadJobHeartbeatSources(dir: string): JobHeartbeatSource[] {
  return loadConfig(dir).jobs.map((job) => ({ id: job.id, name: job.name, state: readJobState(job.id, dir) }));
}

async function runSchedulerJob(job: SchedulerJob, signal: AbortSignal, dir: string): Promise<SchedulerJobOutcome> {
  const outcome = await runJobCommand(job.id, { signal }, dir);
  if (outcome.ok) return { ok: true, rowsSent: outcome.rowsSent ?? 0, durationMs: outcome.durationMs ?? 0 };
  return { ok: false, kind: outcome.kind ?? "other", error: outcome.error ?? "job run failed", consoleMessage: outcome.consoleMessage };
}
