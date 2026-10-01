import { connect, introspectCatalog, type MssqlConnectionConfig } from "@nia/extract/mssql";
import { defaultHomeDir, defaultLogDir, defaultSpoolDir } from "./config/paths.js";
import { loadConfig } from "./config/store.js";
import type { ConnectionEntry } from "./config/types.js";
import { Logger } from "./ops/logger.js";
import { buildMonitoringHeartbeatPayload, MonitoringHeartbeatScheduler } from "./ops/monitoringHeartbeat.js";
import { recordAgentStarted, recordCatalogFingerprint, recordPoll, recordSyncComplete, recordSyncFailed, readState } from "./ops/state.js";
import { logSyncFailure } from "./ops/syncFailureLog.js";
import { syncCatalogIfNeeded } from "./planometry/catalogSync.js";
import { PlanometryClient } from "./planometry/client.js";
import { runPollLoop } from "./planometry/pollLoop.js";
import type { WorkItem } from "./planometry/types.js";
import { KeyedSemaphore } from "./sync/concurrency.js";
import { runSync } from "./sync/runSync.js";
import { LocalSecretStore } from "./secrets/store.js";
import { loadOrCreateMasterKey } from "./secrets/keyfile.js";

export interface AgentLoopOptions {
  dir?: string;
  agentVersion: string;
  signal: AbortSignal;
  logger?: Logger;
}

/**
 * Top-level orchestrator (Phase 3b §4 prep — needed to make packaging's
 * Docker CMD and the health requirements meaningful): loads config/secrets
 * once, then runs one poll loop per connection concurrently until `signal`
 * aborts, recording poll/sync state and driving the optional monitoring
 * heartbeat. `nia-agent start` (index.ts) is this function's only caller.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<void> {
  const dir = options.dir ?? defaultHomeDir();
  const logger = options.logger ?? new Logger(defaultLogDir(dir));
  recordAgentStarted(dir);

  const config = loadConfig(dir);
  const spoolDir = config.spoolDir ?? defaultSpoolDir(dir);
  const masterKey = loadOrCreateMasterKey(dir);
  const secrets = new LocalSecretStore(masterKey, dir);

  const connectionSemaphore = new KeyedSemaphore(1);
  const hostSemaphore = new KeyedSemaphore(1);

  const monitoring = new MonitoringHeartbeatScheduler(
    config.monitoring?.heartbeatUrl,
    config.monitoring?.intervalSeconds,
    () => buildMonitoringHeartbeatPayload(options.agentVersion, readState(dir)),
    (err) => logger.warn("monitoring_heartbeat_failed", { error: err instanceof Error ? err.message : String(err) }),
  );
  monitoring.start();

  if (config.connections.length === 0) {
    logger.warn("no_connections_configured", {});
  }

  try {
    await Promise.all(
      config.connections.map((entry) =>
        runConnectionLoop({ entry, dir, secrets, spoolDir, masterKey, connectionSemaphore, hostSemaphore, agentVersion: options.agentVersion, signal: options.signal, logger }),
      ),
    );
  } finally {
    monitoring.stop();
  }
}

interface ConnectionLoopOptions {
  entry: ConnectionEntry;
  dir: string;
  secrets: LocalSecretStore;
  spoolDir: string;
  masterKey: Buffer;
  connectionSemaphore: KeyedSemaphore;
  hostSemaphore: KeyedSemaphore;
  agentVersion: string;
  signal: AbortSignal;
  logger: Logger;
}

async function runConnectionLoop(options: ConnectionLoopOptions): Promise<void> {
  const { entry, dir, secrets, spoolDir, masterKey, connectionSemaphore, hostSemaphore, agentVersion, signal, logger } = options;

  const credentials = secrets.get<{ user: string; password: string }>(entry.credentialRef);
  const agentKeyRecord = secrets.get<{ agentKey: string }>(entry.agentKeyRef);
  if (!credentials || !agentKeyRecord) {
    logger.error("connection_missing_secrets", { connectionId: entry.id });
    return;
  }

  const client = new PlanometryClient({ baseUrl: entry.planometry.baseUrl, agentKey: agentKeyRecord.agentKey, agentVersion });
  const sqlConfig: MssqlConnectionConfig = {
    server: entry.sqlserver.host,
    port: entry.sqlserver.port,
    database: entry.sqlserver.database,
    user: credentials.user,
    password: credentials.password,
    encrypt: entry.sqlserver.encrypt,
    allowLegacyTls: entry.sqlserver.allowLegacyTls,
    trustServerCertificate: entry.sqlserver.trustServerCertificate,
  };

  try {
    await runPollLoop({
      client,
      connectionId: entry.id,
      signal,
      onPoll: () => recordPoll(entry.id, dir),
      onWork: (work) => handleWork({ entry, dir, client, sqlConfig, work, spoolDir, masterKey, connectionSemaphore, hostSemaphore, signal, logger }),
    });
  } finally {
    await client.close();
  }
}

interface HandleWorkOptions {
  entry: ConnectionEntry;
  dir: string;
  client: PlanometryClient;
  sqlConfig: MssqlConnectionConfig;
  work: WorkItem;
  spoolDir: string;
  masterKey: Buffer;
  connectionSemaphore: KeyedSemaphore;
  hostSemaphore: KeyedSemaphore;
  signal: AbortSignal;
  logger: Logger;
}

async function handleWork(options: HandleWorkOptions): Promise<void> {
  const { entry, dir, client, sqlConfig, work, spoolDir, masterKey, connectionSemaphore, hostSemaphore, signal, logger } = options;
  try {
    const pool = await connect(sqlConfig);
    let catalog;
    try {
      catalog = await introspectCatalog(pool, "UTC");
    } finally {
      await pool.close();
    }

    const fingerprint = await syncCatalogIfNeeded(client, entry.id, catalog, entry.lastCatalogFingerprint, work.catalogRequested ?? false);
    if (fingerprint !== entry.lastCatalogFingerprint) {
      entry.lastCatalogFingerprint = fingerprint;
      recordCatalogFingerprint(entry.id, fingerprint, dir);
    }

    const result = await runSync({ client, work, catalog, sqlConfig, connectionId: entry.id, spoolDir, masterKey, connectionSemaphore, hostSemaphore, signal });
    if (result.outcome === "complete") {
      recordSyncComplete(entry.id, result.totalRows, dir);
    } else if (result.outcome === "failed") {
      const count = recordSyncFailed(entry.id, result.error, dir);
      logSyncFailure(logger, entry.id, result.error, count);
    }
    // "superseded" (409): not a local failure — nothing to record.
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const count = recordSyncFailed(entry.id, message, dir);
    logSyncFailure(logger, entry.id, message, count);
  }
}
