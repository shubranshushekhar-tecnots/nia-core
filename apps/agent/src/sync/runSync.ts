import { randomUUID } from "node:crypto";
import type { ExtractType } from "@nia/extract";
import { defaultLocksDir, defaultSpoolDir } from "../config/paths.js";
import type { SyncJobEntry } from "../config/types.js";
import type { Logger } from "../ops/logger.js";
import { buildWireRow, createFormatter, type MappedColumnFormatter } from "../planometry/formatForTarget.js";
import { PlanometryClient, PlanometryConfigError, PlanometryRejectedError, PlanometryTransientError } from "../planometry/client.js";
import type { TableSchema } from "../planometry/types.js";
import type { KeyedSemaphore } from "./concurrency.js";
import { acquireReplaceLock, ReplaceLockTakenError } from "./replaceLock.js";
import { replaceLoad } from "./replaceLoad.js";
import { readReplaceSpool, removeReplaceSpool, ReplaceSpoolWriter } from "./replaceSpool.js";

/**
 * Rewritten for the v4 migration's slice A4 (docs/plans/planometry-v4-
 * migration.md §10 (A4), run order steps (a)-(f)): drives one `job run`
 * end to end — cross-process + in-process locking, a `getSchema`
 * drift check, extraction straight into the encrypted replace spool
 * (counting null/empty-string keys as it goes), the pre-request safety
 * guards, then the actual push via replaceLoad.ts. The old slice-A1
 * extract-only version (no push, no schema, no locking) is gone —
 * nothing else in the codebase imports this module's old shape.
 */
export interface RunSyncOptions {
  job: SyncJobEntry;
  /** Resolved from the job's pushKeyRef via the local secret store — never logged. */
  pushKey: string;
  /** Extracted column name -> source type, from the connection's live catalog (needed to build formatters). */
  sourceColumnTypes: Record<string, ExtractType>;
  sourceTimeZone?: string;
  /** Agent home dir (config/paths.ts) — spool/lock paths are derived from this. */
  dir: string;
  masterKey: Buffer;
  tableSemaphore: KeyedSemaphore;
  logger: Logger;
  signal?: AbortSignal;
  now?: () => Date;
  lastPartTimeoutMs?: number;
  runId?: string;
  /**
   * Push-style extraction: calls `onRow` once per already-driver-typed
   * source row, synchronously or asynchronously, and resolves once
   * extraction is complete (or rejects/aborts via `signal`). Lets the
   * CLI wire this to `@nia/extract`'s existing `streamExtract` +
   * `NdjsonWriter`-style push protocol without this module knowing
   * anything about SQL Server.
   */
  readSourceRows: (onRow: (row: Record<string, unknown>) => void, signal: AbortSignal) => Promise<void>;
}

export type RunSyncResult =
  | { outcome: "completed"; rowsSent: number; rowsSkipped: number; parts: number; durationMs: number; rowCount: number; version: number }
  | { outcome: "failed"; error: string; consoleMessage?: string };

interface SchemaDriftResult {
  stop: boolean;
  message?: string;
  warnings: string[];
}

/** Run order step (b): stop before reading any rows on a breaking change; warn-only on a new, unmapped column. */
function checkSchemaDrift(job: SyncJobEntry, live: TableSchema): SchemaDriftResult {
  const warnings: string[] = [];
  const liveByName = new Map(live.columns.map((c) => [c.name, c]));
  const mappedTargets = new Set(job.mapping.map((m) => m.target));

  for (const target of mappedTargets) {
    const liveCol = liveByName.get(target);
    if (!liveCol) {
      return { stop: true, message: `mapped target column "${target}" no longer exists on the live schema`, warnings };
    }
    const snapshotCol = job.targetSchemaSnapshot.columns.find((c) => c.name === target);
    if (snapshotCol && snapshotCol.type !== liveCol.type) {
      return {
        stop: true,
        message: `mapped target column "${target}" changed type from ${snapshotCol.type} to ${liveCol.type}`,
        warnings,
      };
    }
  }

  const snapshotKeys = [...job.targetSchemaSnapshot.keyColumns].sort();
  const liveKeys = [...live.keyColumns].sort();
  if (snapshotKeys.join(",") !== liveKeys.join(",")) {
    return { stop: true, message: "the target table's key columns changed", warnings };
  }

  if (!live.supportedModes.includes("replace")) {
    return { stop: true, message: "replace is no longer a supported mode for this table", warnings };
  }

  const knownNames = new Set(job.targetSchemaSnapshot.columns.map((c) => c.name));
  for (const liveCol of live.columns) {
    if (!knownNames.has(liveCol.name)) {
      warnings.push(`new unmapped column "${liveCol.name}" on the target table`);
    }
  }

  return { stop: false, warnings };
}

/** Run order step (c): one formatter per mapped column, built once per run (never per row). */
function buildFormatters(
  job: SyncJobEntry,
  sourceColumnTypes: Record<string, ExtractType>,
  sourceTimeZone: string | undefined,
): MappedColumnFormatter[] {
  return job.mapping.map((m) => {
    const sourceType = sourceColumnTypes[m.source];
    if (!sourceType) {
      throw new Error(`no extracted type known for source column "${m.source}"`);
    }
    const targetCol = job.targetSchemaSnapshot.columns.find((c) => c.name === m.target);
    if (!targetCol) {
      throw new Error(`mapped target column "${m.target}" is missing from the saved schema snapshot`);
    }
    return {
      source: m.source,
      target: m.target,
      format: createFormatter({ sourceType, targetType: targetCol.type, sourceTimeZone }),
    };
  });
}

function toFailure(err: unknown): RunSyncResult {
  if (err instanceof PlanometryConfigError) return { outcome: "failed", error: err.message };
  if (err instanceof PlanometryRejectedError) {
    return { outcome: "failed", error: "Planometry rejected the request (status 400)", consoleMessage: err.message };
  }
  if (err instanceof PlanometryTransientError) return { outcome: "failed", error: `transient error: ${err.message}` };
  if (err instanceof Error) return { outcome: "failed", error: err.message };
  return { outcome: "failed", error: String(err) };
}

/** Combines an optional external signal with a required internal one — no reliance on `AbortSignal.any`. */
function combineSignals(external: AbortSignal | undefined, internal: AbortSignal): AbortSignal {
  if (!external) return internal;
  if (external.aborted || internal.aborted) {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  external.addEventListener("abort", onAbort, { once: true });
  internal.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

export async function runSync(options: RunSyncOptions): Promise<RunSyncResult> {
  const startedAt = Date.now();
  const now = options.now ?? (() => new Date());
  const runId = options.runId ?? randomUUID();
  const { job } = options;
  const spoolDir = defaultSpoolDir(options.dir);
  const locksDir = defaultLocksDir(options.dir);

  const releaseTable = await options.tableSemaphore.acquire(job.targetUrl);
  let releaseLock: (() => void) | undefined;

  try {
    // Step (a): cross-process lock — refuses a second concurrent `job run` against the same table.
    try {
      releaseLock = acquireReplaceLock(locksDir, job.targetUrl, now);
    } catch (err) {
      if (err instanceof ReplaceLockTakenError) return { outcome: "failed", error: err.message };
      throw err;
    }

    // Step (b): getSchema + drift check, before any row is read.
    const schemaClient = new PlanometryClient({ tableUrl: job.targetUrl, pushKey: options.pushKey });
    let schemaAtStart: TableSchema;
    try {
      schemaAtStart = await schemaClient.getSchema();
    } catch (err) {
      return toFailure(err);
    } finally {
      await schemaClient.close();
    }

    const drift = checkSchemaDrift(job, schemaAtStart);
    for (const warning of drift.warnings) options.logger.warn("schema_drift_warning", { message: warning });
    if (drift.stop) {
      const message = drift.message ?? "schema drift detected";
      options.logger.error("schema_drift_stop", { message });
      return { outcome: "failed", error: message };
    }

    // Step (c): extract mapped columns only, map + format, write to the encrypted spool.
    const formatters = buildFormatters(job, options.sourceColumnTypes, options.sourceTimeZone);
    const keyTargets = job.targetSchemaSnapshot.keyColumns;
    const spool = new ReplaceSpoolWriter(spoolDir, runId, options.masterKey);
    await spool.prepare();

    const internalController = new AbortController();
    const combinedSignal = combineSignals(options.signal, internalController.signal);

    let totalRows = 0;
    let nullKeyCount = 0;
    let stopOnNullKey = false;
    let extractionError: unknown;

    try {
      await options.readSourceRows((sourceRow) => {
        if (internalController.signal.aborted) return;
        const wireRow = buildWireRow(formatters, sourceRow);
        const hasNullKey = keyTargets.some((k) => wireRow[k] === null || wireRow[k] === "");
        if (hasNullKey) {
          nullKeyCount += 1;
          if (job.onNullKey === "stop") {
            stopOnNullKey = true;
            internalController.abort();
          }
          return;
        }
        spool.write(wireRow);
        totalRows += 1;
      }, combinedSignal);
    } catch (err) {
      extractionError = err;
    }

    try {
      await spool.finish();
    } catch (err) {
      extractionError = extractionError ?? err;
    }

    // Step (d): guards, before any push request is made.
    if (options.signal?.aborted) {
      await removeReplaceSpool(spoolDir, runId);
      return { outcome: "failed", error: "run aborted" };
    }
    if (stopOnNullKey) {
      await removeReplaceSpool(spoolDir, runId);
      return {
        outcome: "failed",
        error: `${nullKeyCount} row(s) had a null or empty-string key value; stopping the run (onNullKey: stop)`,
      };
    }
    if (extractionError) {
      await removeReplaceSpool(spoolDir, runId);
      return toFailure(extractionError);
    }
    if (totalRows === 0 && !job.allowEmptyReplace) {
      await removeReplaceSpool(spoolDir, runId);
      return { outcome: "failed", error: "the source table returned zero rows; refusing an empty replace (use --allow-empty-replace to proceed)" };
    }

    // Step (e): push.
    const result = await replaceLoad({
      tableUrl: job.targetUrl,
      pushKey: options.pushKey,
      openRows: () => readReplaceSpool(spoolDir, runId, options.masterKey),
      totalRows,
      schemaAtStart,
      logger: options.logger,
      now: options.now,
      lastPartTimeoutMs: options.lastPartTimeoutMs,
      signal: options.signal,
    });

    // Step (f): the spool is removed on success, failure and abort alike.
    await removeReplaceSpool(spoolDir, runId);

    if (result.outcome === "failed") {
      options.logger.error("replace_load_failed", { error: result.error });
      return result;
    }

    const durationMs = Date.now() - startedAt;
    options.logger.info("replace_load_completed", {
      rowsSent: totalRows,
      rowsSkipped: nullKeyCount,
      parts: result.parts,
      durationMs,
      rowCount: result.rowCount,
      version: result.version,
    });

    return {
      outcome: "completed",
      rowsSent: totalRows,
      rowsSkipped: nullKeyCount,
      parts: result.parts,
      durationMs,
      rowCount: result.rowCount,
      version: result.version,
    };
  } finally {
    releaseLock?.();
    releaseTable();
  }
}
