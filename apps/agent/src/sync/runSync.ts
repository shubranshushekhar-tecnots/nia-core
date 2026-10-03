import { rm } from "node:fs/promises";
import path from "node:path";
import type { Catalog, ExtractRequest } from "@nia/extract";
import { NdjsonWriter } from "@nia/extract";
import { connect, streamExtract, type MssqlConnectionConfig } from "@nia/extract/mssql";
import type { KeyedSemaphore } from "./concurrency.js";
import { assertDiskSpace } from "./diskSpace.js";
import { SpoolWriter } from "./spoolWriter.js";

export interface SyncWorkItem {
  runId: string;
  request: ExtractRequest;
}

export interface RunSyncOptions {
  work: SyncWorkItem;
  catalog: Catalog;
  sqlConfig: MssqlConnectionConfig;
  connectionId: string;
  spoolDir: string;
  /** Agent's local master key (secrets/keyfile.ts) — used to encrypt spool chunk files at rest. */
  masterKey: Buffer;
  connectionSemaphore: KeyedSemaphore;
  hostSemaphore: KeyedSemaphore;
  /** Shutdown/cancellation: stops the in-flight DB query immediately; the run is reported failed and its spool cleaned up either way. */
  signal?: AbortSignal;
}

export type RunSyncResult =
  | { outcome: "complete"; totalRows: number }
  | { outcome: "failed"; error: string };

/**
 * Cut back for the v4 migration's slice A1 (docs/plans/planometry-v4-
 * migration.md §10, §965): extracts and spools rows to disk only. The old
 * report-complete/report-failed/chunk-upload/heartbeat steps depended
 * entirely on the deleted work-queue wire protocol and are gone; a later
 * slice rewrites this to push spooled chunks through the v4 push client,
 * keyed by job rather than a Planometry-issued run id.
 */
export async function runSync(options: RunSyncOptions): Promise<RunSyncResult> {
  const { work, catalog, sqlConfig, connectionId, connectionSemaphore, hostSemaphore } = options;
  const runSpoolDir = path.join(options.spoolDir, work.runId);
  const hostKey = `${sqlConfig.server}:${sqlConfig.port ?? 1433}`;

  const releaseConnection = await connectionSemaphore.acquire(connectionId);
  const releaseHost = await hostSemaphore.acquire(hostKey);

  try {
    const spool = new SpoolWriter(runSpoolDir, work.runId, options.masterKey);
    await spool.prepare();
    await assertDiskSpace(runSpoolDir);

    const pool = await connect(sqlConfig);
    const writer = new NdjsonWriter(spool.write);
    try {
      await streamExtract(pool, catalog, work.request, writer, {
        signal: options.signal,
        onDrain: (listener) => spool.onDrain(listener),
      });
    } finally {
      // Mandatory: the DB query (and pool) must be closed before any upload begins.
      await pool.close();
    }

    const { result } = await spool.finish();
    await cleanupSpool(runSpoolDir);

    if (!result.ok) {
      return { outcome: "failed", error: result.error };
    }
    return { outcome: "complete", totalRows: result.totalRows };
  } finally {
    releaseHost();
    releaseConnection();
  }
}

async function cleanupSpool(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
