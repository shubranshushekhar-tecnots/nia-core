import type { ExtractType } from "@nia/extract";
import { NdjsonWriter } from "@nia/extract";
import { connect, introspectCatalog, streamExtract } from "@nia/extract/mssql";
import { defaultHomeDir, defaultLogDir } from "../config/paths.js";
import { findConnection, findJob, loadConfig } from "../config/store.js";
import { loadOrCreateMasterKey } from "../secrets/keyfile.js";
import { LocalSecretStore } from "../secrets/store.js";
import { Logger } from "../ops/logger.js";
import { KeyedSemaphore } from "../sync/concurrency.js";
import { runSync, type RunSyncResult } from "../sync/runSync.js";

/** One process-wide semaphore (per target table URL) — a second concurrent `job run` in the same process is queued, not just refused cross-process (sync/replaceLock.ts handles that). */
const tableSemaphore = new KeyedSemaphore(1);

export interface RunJobOptions {
  /** Accepted for clarity at the call site — the job's only strategy is already "replace" (docs/plans/planometry-v4-migration.md §10 slice A4, item 1). */
  replace?: boolean;
  signal?: AbortSignal;
}

export interface RunJobOutcome {
  ok: boolean;
  summary?: string;
  /** Safe to log — never a raw server message. */
  error?: string;
  /** A 400's raw server message, console-only — never pass this to a logger. */
  consoleMessage?: string;
}

/**
 * `nia-agent job run <id>`: resolves the job + connection + secrets,
 * introspects the live source catalog for the mapped columns' types,
 * and drives `runSync` with a `readSourceRows` adapter built from
 * `@nia/extract`'s existing `streamExtract`/`NdjsonWriter` pair — the
 * same extraction path the old work-queue agent used, reused here as a
 * synchronous push rather than a wire protocol since both ends are this
 * one process.
 */
export async function runJob(id: string, options: RunJobOptions = {}, dir = defaultHomeDir()): Promise<RunJobOutcome> {
  const config = loadConfig(dir);
  const job = findJob(config, id);
  if (!job) return { ok: false, error: `no job with id ${JSON.stringify(id)}` };
  const connection = findConnection(config, job.connectionId);
  if (!connection) return { ok: false, error: `no connection with id ${JSON.stringify(job.connectionId)}` };

  const masterKey = loadOrCreateMasterKey(dir);
  const secrets = new LocalSecretStore(masterKey, dir);
  const pushKeySecret = secrets.get<{ pushKey: string }>(job.pushKeyRef);
  if (!pushKeySecret) return { ok: false, error: `push key for job ${id} is missing from the secret store` };
  const credentials = secrets.get<{ user: string; password: string }>(connection.credentialRef);
  if (!credentials) return { ok: false, error: `credentials for connection ${connection.id} are missing from the secret store` };

  const logger = new Logger(defaultLogDir(dir));

  const pool = await connect({
    server: connection.sqlserver.host,
    port: connection.sqlserver.port,
    database: connection.sqlserver.database,
    user: credentials.user,
    password: credentials.password,
    encrypt: connection.sqlserver.encrypt,
    allowLegacyTls: connection.sqlserver.allowLegacyTls,
    trustServerCertificate: connection.sqlserver.trustServerCertificate,
  });

  try {
    const catalog = await introspectCatalog(pool, connection.sourceTimeZone);
    const table = catalog.tables.find((t) => t.name === job.sourceTable);
    if (!table) return { ok: false, error: `source table/view "${job.sourceTable}" was not found in the catalog` };

    const sourceColumnTypes: Record<string, ExtractType> = {};
    for (const pair of job.mapping) {
      const column = table.columns.find((c) => c.name === pair.source);
      if (!column) return { ok: false, error: `source column "${pair.source}" no longer exists in the catalog` };
      sourceColumnTypes[pair.source] = column.type;
    }

    const mappedSources = job.mapping.map((m) => m.source);

    const readSourceRows = async (onRow: (row: Record<string, unknown>) => void, signal: AbortSignal): Promise<void> => {
      let columns: { name: string; type: ExtractType }[] = [];
      let streamError: string | undefined;

      const writer = new NdjsonWriter((chunk) => {
        const text = chunk.trim();
        if (!text) return true; // keep-alive line
        const parsed = JSON.parse(text) as unknown;
        if (Array.isArray(parsed)) {
          const row: Record<string, unknown> = {};
          columns.forEach((c, i) => {
            row[c.name] = parsed[i];
          });
          onRow(row);
          return true;
        }
        const obj = parsed as { columns?: typeof columns; error?: string };
        if (obj.columns) {
          columns = obj.columns;
          return true;
        }
        if (obj.error) {
          streamError = obj.error;
          return true;
        }
        return true; // the {"end":true,...} trailer — nothing to do
      });

      await streamExtract(pool, catalog, { table: job.sourceTable, columns: mappedSources, filter: [] }, writer, { signal });
      if (streamError) throw new Error(streamError);
    };

    const result = await runSync({
      job,
      pushKey: pushKeySecret.pushKey,
      sourceColumnTypes,
      sourceTimeZone: connection.sourceTimeZone,
      dir,
      masterKey,
      tableSemaphore,
      logger,
      signal: options.signal,
      readSourceRows,
    });

    return outcomeFromResult(result);
  } finally {
    await pool.close();
  }
}

function outcomeFromResult(result: RunSyncResult): RunJobOutcome {
  if (result.outcome === "completed") {
    return {
      ok: true,
      summary: `sent ${result.rowsSent} row(s) (${result.rowsSkipped} skipped) in ${result.parts} part(s), ${result.durationMs}ms — Planometry rowCount ${result.rowCount}, version ${result.version}`,
    };
  }
  return { ok: false, error: result.error, consoleMessage: result.consoleMessage };
}
