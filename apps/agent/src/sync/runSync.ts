import { rm } from "node:fs/promises";
import path from "node:path";
import type { Catalog } from "@nia/extract";
import { NdjsonWriter } from "@nia/extract";
import { connect, streamExtract, type MssqlConnectionConfig } from "@nia/extract/mssql";
import { ChunkRejectedError, type PlanometryClient } from "../planometry/client.js";
import { HeartbeatScheduler } from "../planometry/heartbeatScheduler.js";
import type { WorkItem } from "../planometry/types.js";
import type { KeyedSemaphore } from "./concurrency.js";
import { assertDiskSpace } from "./diskSpace.js";
import { uploadChunks } from "./chunkUploader.js";
import { SpoolWriter } from "./spoolWriter.js";

export interface RunSyncOptions {
  client: PlanometryClient;
  work: WorkItem;
  catalog: Catalog;
  sqlConfig: MssqlConnectionConfig;
  connectionId: string;
  spoolDir: string;
  connectionSemaphore: KeyedSemaphore;
  hostSemaphore: KeyedSemaphore;
  heartbeatIntervalMs?: number;
  /** Shutdown/cancellation: stops the in-flight DB query immediately and aborts any remaining chunk upload; the run is reported failed and its spool cleaned up either way. */
  signal?: AbortSignal;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Outcome summary for the caller (ops/state.ts's recordSyncComplete/
 * recordSyncFailed) — runSync already reports complete/failed to
 * Planometry itself internally, this is purely for local state/logging.
 */
export type RunSyncResult =
  | { outcome: "complete"; totalRows: number }
  | { outcome: "failed"; error: string }
  /** Planometry rejected a chunk with 409 (run superseded) — not a local failure worth recording as one. */
  | { outcome: "superseded" };

/**
 * Runs one sync end to end (Phase 2 §4/§11 slice d): extract -> spool to
 * disk -> close the DB query -> upload spooled chunks -> report complete
 * or failed -> clean up the spool. One sync at a time per connection,
 * plus a per-host:port semaphore, per Phase 2 §5.
 */
export async function runSync(options: RunSyncOptions): Promise<RunSyncResult> {
  const { client, work, catalog, sqlConfig, connectionId, connectionSemaphore, hostSemaphore } = options;
  const runSpoolDir = path.join(options.spoolDir, work.runId);
  const hostKey = `${sqlConfig.server}:${sqlConfig.port ?? 1433}`;

  const releaseConnection = await connectionSemaphore.acquire(connectionId);
  const releaseHost = await hostSemaphore.acquire(hostKey);

  const heartbeat = new HeartbeatScheduler(options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS, () => {
    client.heartbeat(work.runId).catch(() => {});
  });

  try {
    const spool = new SpoolWriter(runSpoolDir, work.runId);
    await spool.prepare();
    await assertDiskSpace(runSpoolDir);

    heartbeat.start();

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

    const { files, result } = await spool.finish();
    heartbeat.markActivity();

    if (!result.ok) {
      await client.reportFailed(work.runId, { error: result.error });
      await cleanupSpool(runSpoolDir);
      return { outcome: "failed", error: result.error };
    }

    try {
      await uploadChunks(client, work.runId, files, heartbeat, { signal: options.signal });
    } catch (err) {
      if (err instanceof ChunkRejectedError) {
        // Superseded run: Planometry rejected the chunk itself, nothing further to report.
        await cleanupSpool(runSpoolDir);
        return { outcome: "superseded" };
      }
      const error = err instanceof Error ? err.message : String(err);
      await client.reportFailed(work.runId, { error });
      await cleanupSpool(runSpoolDir);
      return { outcome: "failed", error };
    }

    await client.reportComplete(work.runId, { totalRows: result.totalRows, totalChunks: files.length });
    await cleanupSpool(runSpoolDir);
    return { outcome: "complete", totalRows: result.totalRows };
  } finally {
    heartbeat.stop();
    releaseHost();
    releaseConnection();
  }
}

async function cleanupSpool(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
