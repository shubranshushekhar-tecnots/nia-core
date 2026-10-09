import { runJob as runJobCommand } from "./cli/runJobCommand.js";
import { defaultHomeDir, defaultLogDir } from "./config/paths.js";
import { findConnection, loadConfig } from "./config/store.js";
import type { LinkConfig } from "./config/types.js";
import { buildAgentConnectionReports } from "./link/agentConnectionReports.js";
import { CheckInLoop } from "./link/checkInLoop.js";
import { LinkWatcher } from "./link/linkWatcher.js";
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
import { loadOrCreateApiToken } from "./localApi/authToken.js";
import { createLocalApiServer } from "./localApi/server.js";
import type { RouteDefinition } from "./localApi/router.js";
import { buildStatusRoutes } from "./localApi/routes/status.js";
import { buildPairRoutes } from "./localApi/routes/pair.js";
import { buildServersRoutes } from "./localApi/routes/servers.js";
import { buildConnectionsRoutes } from "./localApi/routes/connections.js";
import { buildTablesRoutes } from "./localApi/routes/tables.js";
import { buildDestinationsRoutes } from "./localApi/routes/destinations.js";
import { buildLogsRoutes } from "./localApi/routes/logs.js";
import { buildDiagnosticsRoutes } from "./localApi/routes/diagnostics.js";
import { buildOtcRoutes, buildUiSessionRoutes } from "./localApi/routes/uiAuth.js";
import { mirrorRoutesForUi } from "./localApi/uiProxyRoutes.js";
import { buildUiStaticHandler } from "./localApi/uiStaticHandler.js";

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

  // Phase 1 (local control API) — never fatal: a desktop app loses its
  // control channel if this fails to bind, but jobs/scheduler/check-in
  // must keep running regardless (see localApi/server.ts's doc comment).
  const localApiDeps = { dir, agentVersion: options.agentVersion, logger };
  // Built once and reused by both the bearer originals and their
  // `/ui/api/*` mirrors below, so e.g. `/pair`'s rate limiter is one
  // shared budget regardless of which caller (CLI-driven bearer request
  // or browser-driven session request) hits it -- intentional, see
  // uiProxyRoutes.ts. `/otc` stays bearer-only (only `nia-agent open`,
  // which already read the real token off disk, can mint a code) and is
  // deliberately excluded from `mirrorableRoutes` / never mirrored.
  const mirrorableRoutes: RouteDefinition[] = [
    ...buildStatusRoutes(localApiDeps),
    ...buildPairRoutes(localApiDeps),
    ...buildServersRoutes(),
    ...buildConnectionsRoutes(localApiDeps),
    ...buildTablesRoutes(localApiDeps),
    ...buildDestinationsRoutes(localApiDeps),
    ...buildLogsRoutes(localApiDeps),
    ...buildDiagnosticsRoutes(localApiDeps),
  ];
  const localApiRoutes: RouteDefinition[] = [
    ...mirrorableRoutes,
    ...buildOtcRoutes(),
    ...mirrorRoutesForUi(mirrorableRoutes),
    ...buildUiSessionRoutes(),
  ];
  const localApi = await createLocalApiServer({
    dir,
    apiToken: loadOrCreateApiToken(dir),
    routes: localApiRoutes,
    logger,
    staticHandler: buildUiStaticHandler(),
  });

  let linkSession: LinkSession | undefined;

  const scheduler = new JobScheduler({
    dir,
    logger,
    loadJobs: () => loadSchedulerJobs(dir),
    runJob: (job, signal, forceReplace, extra) => runSchedulerJob(job, signal, forceReplace, dir, extra),
    maxConcurrentRuns: loadConfig(dir).maxConcurrentRuns,
    // Slice: wake a held check-in the moment a run report lands, instead of waiting for it to finish holding on its own.
    onRunRecorded: () => linkSession?.checkInLoop.wake(),
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

  // Slice: `pair`/`unpair` (run from a separate `nia-agent` CLI invocation
  // while this service is already running) used to only take effect on
  // the next restart — the link was read from disk exactly once, here.
  // The LinkWatcher below polls for that same change and starts/stops
  // the check-in session live, so pair/unpair is noticed within a few
  // seconds, no restart required.
  async function applyLink(link: LinkConfig | undefined): Promise<void> {
    if (linkSession) {
      await linkSession.stop();
      linkSession = undefined;
    }
    if (!link) return;
    const session = buildLinkSession(link, dir, logger, scheduler, options.agentVersion);
    if (!session) {
      logger.warn("link_agent_key_missing", {});
      return;
    }
    linkSession = session;
    session.checkInLoop.start();
  }

  await applyLink(loadConfig(dir).link);
  const linkWatcher = new LinkWatcher({ dir, onChange: (link) => void applyLink(link) });
  linkWatcher.start();

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
    linkWatcher.stop();
    await scheduler.stop();
    await linkSession?.stop();
    await localApi?.close();
  }
}

interface LinkSession {
  checkInLoop: CheckInLoop;
  stop: () => Promise<void>;
}

/** Builds (but does not start) everything a paired agent needs — the check-in loop plus its task/setup/upload clients — or `undefined` if the link's agent key is missing from the local secret store. */
function buildLinkSession(
  link: LinkConfig,
  dir: string,
  logger: Logger,
  scheduler: JobScheduler,
  agentVersion: string,
): LinkSession | undefined {
  const masterKey = loadOrCreateMasterKey(dir);
  const secrets = new LocalSecretStore(masterKey, dir);
  const secret = secrets.get<{ agentKey: string }>(link.agentKeyRef);
  if (!secret) return undefined;

  const transport = new HttpAgentTransport({ platformUrl: link.platformUrl, agentKey: secret.agentKey });
  const taskResultsClient = new TaskResultsClient({ platformUrl: link.platformUrl, agentKey: secret.agentKey });
  const uploadClient = new ReadBatchUploadClient({ platformUrl: link.platformUrl, agentKey: secret.agentKey });
  // Slice R5b — the scheduler itself satisfies TaskRunner's JobActionRunner (runNow), so run_now reuses the scheduler's own lock/semaphore/run-report path.
  // Slice T2 — uploadClient lets TaskRunner's read_batch handler upload batches directly to the bridge.
  const taskRunner = new TaskRunner(taskResultsClient, logger, dir, scheduler, uploadClient);
  const setupClient = new SetupClient({ platformUrl: link.platformUrl, agentKey: secret.agentKey });
  const setupManager = new SetupManager({ setupClient, logger, dir });
  const checkInLoop = new CheckInLoop({
    transport,
    agentVersion,
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

  return {
    checkInLoop,
    stop: async () => {
      await checkInLoop.stop();
      await transport.close();
      await taskResultsClient.close();
      await setupClient.close();
      await uploadClient.close();
    },
  };
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
