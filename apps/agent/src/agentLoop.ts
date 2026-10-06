import { runJob as runJobCommand } from "./cli/runJobCommand.js";
import { defaultHomeDir, defaultLogDir } from "./config/paths.js";
import { findConnection, loadConfig } from "./config/store.js";
import { buildAgentConnectionReports } from "./link/agentConnectionReports.js";
import { CheckInLoop } from "./link/checkInLoop.js";
import { buildLocalJobReports } from "./link/localJobReports.js";
import { ReadBatchUploadClient } from "./link/readBatchUploadClient.js";
import * as runReportOutbox from "./link/runReportOutbox.js";
import { SetupClient } from "./link/setupClient.js";
import { SetupManager } from "./link/setupManager.js";
import { TaskResultsClient } from "./link/taskResultsClient.js";
import { TaskRunner } from "./link/taskRunner.js";
import { HttpAgentTransport } from "./link/transport.js";
import { Logger } from "./ops/logger.js";
import { buildMonitoringHeartbeatPayload, MonitoringHeartbeatScheduler, type JobHeartbeatSource } from "./ops/monitoringHeartbeat.js";
import { recordCheckInSuccess, recordRevoked } from "./ops/linkState.js";
import { readJobState, recordAgentStarted } from "./ops/state.js";
import { loadOrCreateMasterKey } from "./secrets/keyfile.js";
import { LocalSecretStore } from "./secrets/store.js";
import { JobScheduler, type RunNowExtra, type SchedulerJob, type SchedulerJobOutcome } from "./scheduler/jobScheduler.js";

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
    runJob: (job, signal, forceReplace, extra) => runSchedulerJob(job, signal, forceReplace, dir, extra),
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

  const link = loadConfig(dir).link;
  let checkInLoop: CheckInLoop | undefined;
  let transport: HttpAgentTransport | undefined;
  let taskResultsClient: TaskResultsClient | undefined;
  let setupClient: SetupClient | undefined;
  let uploadClient: ReadBatchUploadClient | undefined;
  if (link) {
    const masterKey = loadOrCreateMasterKey(dir);
    const secrets = new LocalSecretStore(masterKey, dir);
    const secret = secrets.get<{ agentKey: string }>(link.agentKeyRef);
    if (secret) {
      transport = new HttpAgentTransport({ platformUrl: link.platformUrl, agentKey: secret.agentKey });
      taskResultsClient = new TaskResultsClient({ platformUrl: link.platformUrl, agentKey: secret.agentKey });
      uploadClient = new ReadBatchUploadClient({ platformUrl: link.platformUrl, agentKey: secret.agentKey });
      // Slice R5b — the scheduler itself satisfies TaskRunner's JobActionRunner (runNow), so run_now reuses the scheduler's own lock/semaphore/run-report path.
      // Slice T2 — uploadClient lets TaskRunner's read_batch handler upload batches directly to the bridge.
      const taskRunner = new TaskRunner(taskResultsClient, logger, dir, scheduler, uploadClient);
      setupClient = new SetupClient({ platformUrl: link.platformUrl, agentKey: secret.agentKey });
      const setupManager = new SetupManager({ setupClient, logger, dir });
      checkInLoop = new CheckInLoop({
        transport,
        agentVersion: options.agentVersion,
        logger,
        buildLocalJobs: () => buildLocalJobReports(dir),
        buildRunReports: () => runReportOutbox.pendingReports(dir, logger),
        buildLocalConnections: () => buildAgentConnectionReports(dir),
        onSuccess: (response) => {
          recordCheckInSuccess(dir);
          runReportOutbox.acknowledge(dir, response.acknowledgedRunIds ?? []);
          // Item 3: fire-and-forget — applying setups must never delay check-ins/scheduling.
          if (response.setups) {
            void setupManager.handleCheckIn(response.setups).catch((err) => {
              logger.warn("setup_check_in_failed", { error: err instanceof Error ? err.message : String(err) });
            });
          }
        },
        onTasks: (tasks) => taskRunner.handle(tasks),
        onRevoked: () => recordRevoked(dir),
      });
      checkInLoop.start();
    } else {
      logger.warn("link_agent_key_missing", {});
    }
  }

  /**
   * Explicitly holds the process open until `options.signal` aborts,
   * with or without jobs. Without this, `agent start` returned almost
   * immediately: an `AbortSignal` "abort" listener does not ref the
   * Node event loop, and (before this fix) neither did the scheduler's
   * own timers (they were `.unref()`'d — see jobScheduler.ts's
   * `start()`/`scheduleNext()`) or the monitoring heartbeat's timer.
   * This is the one handle `runAgentLoop` itself owns for that purpose,
   * independent of whether the scheduler happens to have any timers of
   * its own running — found during Phase B's real-run verification.
   */
  const keepAlive = setInterval(() => {}, 1 << 30);

  try {
    await new Promise<void>((resolve) => {
      if (options.signal.aborted) {
        resolve();
        return;
      }
      options.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    clearInterval(keepAlive);
    monitoring.stop();
    await scheduler.stop();
    await checkInLoop?.stop();
    await transport?.close();
    await taskResultsClient?.close();
    await setupClient?.close();
    await uploadClient?.close();
  }
}

/** Every job whose connection still exists, as of the current config on disk. A job referencing a since-deleted connection is skipped (defensive — `job remove`/`connection remove` shouldn't leave that state). */
function loadSchedulerJobs(dir: string): SchedulerJob[] {
  const config = loadConfig(dir);
  const jobs: SchedulerJob[] = [];
  for (const job of config.jobs) {
    const connection = findConnection(config, job.connectionId);
    if (!connection) continue;
    jobs.push({
      id: job.id,
      name: job.name,
      connectionId: job.connectionId,
      schedule: job.schedule,
      replaceSchedule: job.replaceSchedule,
      pollIntervalSeconds: job.pollIntervalSeconds,
      timeZone: connection.sourceTimeZone,
    });
  }
  return jobs;
}

function loadJobHeartbeatSources(dir: string): JobHeartbeatSource[] {
  return loadConfig(dir).jobs.map((job) => ({ id: job.id, name: job.name, state: readJobState(job.id, dir) }));
}

async function runSchedulerJob(
  job: SchedulerJob,
  signal: AbortSignal,
  forceReplace: boolean,
  dir: string,
  extra?: RunNowExtra,
): Promise<SchedulerJobOutcome> {
  const outcome = await runJobCommand(
    job.id,
    { signal, replace: forceReplace, paramOverrides: extra?.paramOverrides, allowMassDelete: extra?.allowMassDelete },
    dir,
  );
  if (outcome.ok)
    return {
      ok: true,
      rowsSent: outcome.rowsSent ?? 0,
      durationMs: outcome.durationMs ?? 0,
      empty: outcome.empty,
      rowsDeleted: outcome.rowsDeleted,
      parts: outcome.parts,
      mode: outcome.mode,
    };
  return { ok: false, kind: outcome.kind ?? "other", error: outcome.error ?? "job run failed", consoleMessage: outcome.consoleMessage };
}
