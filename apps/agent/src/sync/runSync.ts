import { randomUUID } from "node:crypto";
import type { ExtractType } from "@nia/extract";
import { defaultLocksDir, defaultSpoolDir } from "../config/paths.js";
import type { SyncJobEntry } from "../config/types.js";
import type { Logger } from "../ops/logger.js";
import { pauseJobState, setLastWatermark } from "../ops/state.js";
import { buildKeyRow, buildWireRow, createFormatter, FormatForTargetError, type MappedColumnFormatter, type WireRow } from "../planometry/formatForTarget.js";
import { PlanometryClient, PlanometryConfigError, PlanometryRejectedError, PlanometryTransientError } from "../planometry/client.js";
import type { PushMode, TableSchema } from "../planometry/types.js";
import type { KeyedSemaphore } from "./concurrency.js";
import { deletePush } from "./deletePush.js";
import { assertDiskSpace, InsufficientDiskSpaceError } from "./diskSpace.js";
import {
  buildReplaceKeyList,
  canonicalKeyString,
  computeReconciliation,
  readSavedKeyListMeta,
  sweepStaleKeyListGenerations,
  type ReconciliationOutcome,
} from "./keyReconciliation.js";
import { acquireReplaceLock, ReplaceLockTakenError } from "./replaceLock.js";
import { replaceLoad } from "./replaceLoad.js";
import { readReplaceSpool, removeReplaceSpool, ReplaceSpoolWriter } from "./replaceSpool.js";
import { isSoftDeletedRow } from "./softDelete.js";
import { upsertPush } from "./upsertPush.js";
import { computeNextWatermark } from "./watermark.js";

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
  /** Pre-flight threshold for the spool directory's free disk space (sync/diskSpace.ts). Defaults to DEFAULT_MIN_FREE_BYTES; override only for tests. */
  minFreeBytes?: number;
  /**
   * Push-style extraction: calls `onRow` once per already-driver-typed
   * source row, synchronously or asynchronously, and resolves once
   * extraction is complete (or rejects/aborts via `signal`). Lets the
   * CLI wire this to `@nia/extract`'s existing `streamExtract` +
   * `NdjsonWriter`-style push protocol without this module knowing
   * anything about SQL Server.
   */
  readSourceRows: (onRow: (row: Record<string, unknown>) => void, signal: AbortSignal) => Promise<void>;
  /**
   * `job.strategy === "upsertDelta"` only (slice C1, §1.1/§10). Drives the
   * replace-vs-upsert push branch in step (e) and the post-push watermark
   * computation/persistence. Absent entirely for `strategy: "replace"` jobs
   * (today's unchanged path). `isParamOverride` is this module's own
   * resolution of a gap the plan doc didn't cover explicitly: a `job run
   * --param` one-off run against an `upsertDelta` job must never replace-
   * wipe the table (its filter is a deliberately narrow override, not the
   * job's real one) and must never read/write the saved watermark — so it
   * always pushes via "upsert" with `persist: false`, regardless of whether
   * a saved watermark exists.
   */
  delta?: {
    watermarkColumn: string;
    overlapSeconds: number;
    /** From `getLastWatermark()` — undefined means "first run, treat as replace" (unless `isParamOverride`). */
    savedWatermark?: string;
    /** `job run --replace` — an explicit forced full reload of an `upsertDelta` job. */
    forceReplace: boolean;
    isParamOverride: boolean;
    /** Read via `readServerClock()` before extraction starts (`S` in the formula). */
    serverClockAtStart: string;
    /** `sync/watermark.ts`'s `computeJobFingerprint(job)` — saved alongside the watermark on success so a future run can tell whether it's still valid (task item 1, the fingerprint rule). */
    fingerprint: string;
  };
  /**
   * `job.deleteMode === "reconciliation"` only (§1.2/§10, slice D1 + its
   * follow-up). The caller (cli/runJobCommand.ts) decides when to pass
   * this — only for an `upsertDelta` job that isn't a `--param` override
   * run (item 3: "a `--param` override run never reads or writes the
   * list"). Reuses `delta.fingerprint` rather than carrying its own.
   *
   * With no valid saved list (none ever written, or a fingerprint
   * mismatch), the run is forced to "replace", exactly like a missing
   * watermark — the saved list is then rebuilt directly from the rows
   * just replaced, no scan or deletes. On an ongoing delta ("upsert")
   * run, the current keys are scanned and the delete set + mass-delete
   * guard are both computed BEFORE any push request is sent; only once
   * the guard passes do upserts get pushed, then deletes. The saved
   * watermark and the new saved key list are committed together at the
   * very end, only after every push involved has succeeded — on a guard
   * trip or any failure, neither changes.
   */
  reconciliation?: {
    readKeyScanRows: (onRow: (row: Record<string, unknown>) => void, signal: AbortSignal) => Promise<void>;
    maxDeletePercent: number;
    allowMassDelete: boolean;
  };
  /**
   * `job.deleteMode === "softDelete"` only (§1.2/§10, slice D2). The
   * caller (cli/runJobCommand.ts) sets this for an upsertDelta job
   * regardless of whether this run is a param-override run — unlike
   * reconciliation, a `--param` override run still classifies a flagged
   * row as a delete here (§1.2 groups "delta run and --param override
   * run" together). On an "upsert" push, a row whose raw
   * `sourceRow[column] === true` is queued as a key-only delete instead
   * of an upsert. On a "replace" push, such a row is excluded entirely
   * (defense-in-depth — cli/runJobCommand.ts also excludes it at the SQL
   * level for an actual replace, via sync/softDelete.ts's
   * `softDeleteExclusionFilter`, but this module never trusts that alone).
   * No mass-delete guard applies to this mode, and no new stored state.
   */
  softDelete?: { column: string };
}

/**
 * Classifies why a run failed, so the scheduler (scheduler/jobScheduler.ts)
 * can decide pause vs. retry-with-backoff vs. "just wait for next schedule"
 * without re-deriving it from error text. Per §10(B2) item 3, only
 * "config" (401/404), "schemaDrift", "typeMismatch" and "nullKey" pause the
 * job. "transient" and "diskSpace" retry at 1/5/15 min and never pause.
 * Everything else ("lockTaken", "aborted", "emptyReplace", "rejected" — a
 * Planometry 400 at the getSchema/push step, "mismatch" — a row-count
 * mismatch during the push itself, "other") neither pauses nor retries —
 * the job just waits for its next scheduled tick.
 */
export type RunSyncFailureKind =
  | "lockTaken"
  | "schemaDrift"
  | "typeMismatch"
  | "nullKey"
  | "emptyReplace"
  | "aborted"
  | "config"
  | "rejected"
  | "mismatch"
  | "transient"
  | "diskSpace"
  | "massDelete"
  | "other";

export type RunSyncResult =
  | {
      outcome: "completed";
      rowsSent: number;
      rowsSkipped: number;
      parts: number;
      durationMs: number;
      /** Unset for an `upsertDelta` run (Planometry's push response for "upsert" carries no whole-table rowCount/version — only a "replace" response does). */
      rowCount?: number;
      version?: number;
      mode: PushMode;
      /** `delta`-driven runs only (slice C1) — the saved watermark before/after this run (after reflects the computed value even on the rare case it wasn't persisted — see step (e)'s "leave unchanged" comment). */
      watermarkBefore?: string;
      watermarkAfter?: string;
      /** Set only when key reconciliation actually ran (an upsert-mode delta run with `options.reconciliation` set). */
      reconciliation?: { deletesSent: number; duplicateKeyCount: number };
      /** Set only when `options.softDelete` was active and at least one flagged row was queued as a delete on an upsert-mode run (slice D2). */
      softDelete?: { deletesSent: number };
    }
  | { outcome: "failed"; error: string; consoleMessage?: string; kind: RunSyncFailureKind };

interface SchemaDriftResult {
  stop: boolean;
  message?: string;
  warnings: string[];
}

/** Run order step (b): stop before reading any rows on a breaking change; warn-only on a new, unmapped column. */
function checkSchemaDrift(job: SyncJobEntry, live: TableSchema, pushMode: PushMode): SchemaDriftResult {
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

  if (!live.supportedModes.includes(pushMode)) {
    return { stop: true, message: `${pushMode} is no longer a supported mode for this table`, warnings };
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
      // Every extracted "datetime" value reaching this call site came from the no-offset
      // family (datetime/smalldatetime/datetime2) as a wall-clock-text passthrough from
      // packages/extract — see valueSerializer.ts. noOffsetSource lets createFormatter
      // guard against one ever arriving here already carrying a zone marker.
      format: createFormatter({ sourceType, targetType: targetCol.type, sourceTimeZone, noOffsetSource: true }),
    };
  });
}

function toFailure(err: unknown): RunSyncResult {
  if (err instanceof PlanometryConfigError) return { outcome: "failed", error: err.message, kind: "config" };
  if (err instanceof PlanometryRejectedError) {
    return { outcome: "failed", error: "Planometry rejected the request (status 400)", consoleMessage: err.message, kind: "rejected" };
  }
  if (err instanceof PlanometryTransientError) return { outcome: "failed", error: `transient error: ${err.message}`, kind: "transient" };
  if (err instanceof FormatForTargetError) return { outcome: "failed", error: err.message, kind: "typeMismatch" };
  if (err instanceof Error) return { outcome: "failed", error: err.message, kind: "other" };
  return { outcome: "failed", error: String(err), kind: "other" };
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
  const { job, delta } = options;
  const spoolDir = defaultSpoolDir(options.dir);
  const locksDir = defaultLocksDir(options.dir);

  // Three-way push-mode resolution (§6): a param-override one-off run never
  // replace-wipes the table (its filter is a deliberately narrow override,
  // not the job's real one); a forced replace, a first run (no saved
  // watermark yet), or — with key reconciliation active — no valid saved
  // key list (none ever written, or a fingerprint mismatch) for an
  // upsertDelta job still does a full replace, driven through the
  // unchanged replaceLoad() path below; everything else is an ongoing
  // delta run, pushed via "upsert". Reconciliation's stale-generation
  // sweep runs here too, unconditionally whenever reconciliation is
  // active, before anything else touches this job's key-list dir.
  let pushMode: PushMode;
  if (!delta || delta.isParamOverride) {
    pushMode = delta ? "upsert" : "replace";
  } else {
    let reconciliationListValid = true;
    if (options.reconciliation) {
      await sweepStaleKeyListGenerations(options.dir, job.id);
      const savedMeta = await readSavedKeyListMeta(options.dir, job.id);
      reconciliationListValid = savedMeta !== undefined && savedMeta.fingerprint === delta.fingerprint;
    }
    pushMode =
      delta.forceReplace || delta.savedWatermark === undefined || (options.reconciliation !== undefined && !reconciliationListValid)
        ? "replace"
        : "upsert";
  }
  // Never persist a param-override run's watermark (§2's ops/state.ts note) — every other delta run does, including a forced-replace/first-run one (isReplace: true in the formula).
  const persistWatermark = delta !== undefined && !delta.isParamOverride;

  const releaseTable = await options.tableSemaphore.acquire(job.targetUrl);
  let releaseLock: (() => void) | undefined;

  try {
    // Step (a): cross-process lock — refuses a second concurrent `job run` against the same table.
    try {
      releaseLock = acquireReplaceLock(locksDir, job.targetUrl, now);
    } catch (err) {
      if (err instanceof ReplaceLockTakenError) return { outcome: "failed", error: err.message, kind: "lockTaken" };
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

    const drift = checkSchemaDrift(job, schemaAtStart, pushMode);
    for (const warning of drift.warnings) options.logger.warn("schema_drift_warning", { message: warning });
    if (drift.stop) {
      const message = drift.message ?? "schema drift detected";
      options.logger.error("schema_drift_stop", { message });
      return { outcome: "failed", error: message, kind: "schemaDrift" };
    }

    // Step (c): extract mapped columns only, map + format, write to the encrypted spool.
    let formatters: MappedColumnFormatter[];
    try {
      formatters = buildFormatters(job, options.sourceColumnTypes, options.sourceTimeZone);
    } catch (err) {
      if (err instanceof FormatForTargetError) return { outcome: "failed", error: err.message, kind: "typeMismatch" };
      throw err;
    }
    const keyTargets = job.targetSchemaSnapshot.keyColumns;
    const spool = new ReplaceSpoolWriter(spoolDir, runId, options.masterKey);
    await spool.prepare();

    // Soft delete (§1.2/§10, slice D2): only an "upsert" push ever queues
    // flagged rows as deletes — a "replace" push excludes them entirely
    // instead (see the row loop below), so its spool is never created.
    const softDeleteRunId = `${runId}-softdelete`;
    const softDeleteSpool = options.softDelete && pushMode === "upsert" ? new ReplaceSpoolWriter(spoolDir, softDeleteRunId, options.masterKey) : undefined;
    if (softDeleteSpool) await softDeleteSpool.prepare();

    // Step (c.0): free-disk-space pre-flight, before any row is read.
    try {
      await assertDiskSpace(spoolDir, options.minFreeBytes);
    } catch (err) {
      if (err instanceof InsufficientDiskSpaceError) {
        await removeReplaceSpool(spoolDir, runId);
        await removeReplaceSpool(spoolDir, softDeleteRunId);
        return { outcome: "failed", error: err.message, kind: "diskSpace" };
      }
      throw err;
    }

    const internalController = new AbortController();
    const combinedSignal = combineSignals(options.signal, internalController.signal);

    let totalRows = 0;
    let nullKeyCount = 0;
    let stopOnNullKey = false;
    let extractionError: unknown;
    // `M` in the watermark formula — tracked from the raw (unformatted) source
    // row, since `delta.watermarkColumn` need not be in `job.mapping`/`wireRow`.
    // Plain string `>` is valid: packages/extract's valueSerializer.ts always
    // emits this family as a fixed-width, zero-padded wall-clock string.
    let maxSeenWatermark: string | undefined;
    const extractionStartedAt = Date.now();

    // Reconciliation only ever reads/writes the saved list on an ongoing
    // upsert-mode delta run (never a replace, never a param override —
    // item 3) — this run's upserted keys are collected inline here, from
    // the already-built `wireRow`, so the later reconciliation pass never
    // needs a third pass over this run's own rows.
    const trackUpsertedKeys = options.reconciliation !== undefined && pushMode === "upsert";
    const upsertedKeysThisRun = new Set<string>();
    let softDeleteCount = 0;

    try {
      await options.readSourceRows((sourceRow) => {
        if (internalController.signal.aborted) return;
        if (delta) {
          const raw = sourceRow[delta.watermarkColumn];
          if (typeof raw === "string" && (maxSeenWatermark === undefined || raw > maxSeenWatermark)) {
            maxSeenWatermark = raw;
          }
        }
        // Soft delete (§1.2, slice D2): a "replace" push excludes a
        // flagged row entirely — never written anywhere, never counted —
        // this is defense-in-depth even though cli/runJobCommand.ts also
        // excludes it at the SQL level for an actual replace.
        if (options.softDelete && pushMode === "replace" && isSoftDeletedRow(sourceRow, options.softDelete.column)) {
          return;
        }
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
        // Soft delete, upsert push (§1.2): a flagged row is queued as a
        // key-only delete instead of an upsert — pushed after the main
        // upsert request, in step (e.5) below ("upserts first, then
        // deletes", same ordering as key reconciliation's D1 delete push).
        if (options.softDelete && pushMode === "upsert" && softDeleteSpool && isSoftDeletedRow(sourceRow, options.softDelete.column)) {
          softDeleteSpool.write(buildKeyRow(formatters, sourceRow, keyTargets));
          softDeleteCount += 1;
          return;
        }
        if (trackUpsertedKeys) {
          const keyRow: WireRow = {};
          for (const k of keyTargets) keyRow[k] = wireRow[k] ?? null;
          upsertedKeysThisRun.add(canonicalKeyString(keyRow));
        }
        spool.write(wireRow);
        totalRows += 1;
      }, combinedSignal);
    } catch (err) {
      extractionError = err;
    }
    const extractionDurationMs = Date.now() - extractionStartedAt;

    try {
      await spool.finish();
      if (softDeleteSpool) await softDeleteSpool.finish();
    } catch (err) {
      extractionError = extractionError ?? err;
    }

    // Step (d): guards, before any push request is made.
    if (options.signal?.aborted) {
      await removeReplaceSpool(spoolDir, runId);
      await removeReplaceSpool(spoolDir, softDeleteRunId);
      return { outcome: "failed", error: "run aborted", kind: "aborted" };
    }
    if (stopOnNullKey) {
      await removeReplaceSpool(spoolDir, runId);
      await removeReplaceSpool(spoolDir, softDeleteRunId);
      return {
        outcome: "failed",
        error: `${nullKeyCount} row(s) had a null or empty-string key value; stopping the run (onNullKey: stop)`,
        kind: "nullKey",
      };
    }
    if (extractionError) {
      await removeReplaceSpool(spoolDir, runId);
      await removeReplaceSpool(spoolDir, softDeleteRunId);
      return toFailure(extractionError);
    }
    // An empty table is only refused for a replace-style push — zero changed
    // rows on an ongoing upsert run is an expected, successful no-op (§6
    // "Zero changed rows is a success with no request").
    if (totalRows === 0 && pushMode !== "upsert" && !job.allowEmptyReplace) {
      await removeReplaceSpool(spoolDir, runId);
      await removeReplaceSpool(spoolDir, softDeleteRunId);
      return {
        outcome: "failed",
        error: "the source table returned zero rows; refusing an empty replace (use --allow-empty-replace to proceed)",
        kind: "emptyReplace",
      };
    }

    // Step (d.5): key reconciliation scan + guard (§1.2/§10, slice D1 +
    // its follow-up) — runs entirely BEFORE any push request for this run
    // is sent. The caller only sets `options.reconciliation` for an
    // upsertDelta job that isn't a `--param` override run (item 3); a
    // replace-mode run (forced replace, first run, or an invalid saved
    // list — resolved into `pushMode` above) never scans or computes
    // deletes, so this block is skipped entirely for it. If the guard
    // trips (or the scan itself fails), the run fails here, before
    // `upsertPush`/`replaceLoad` is ever called — no request of any kind
    // is sent.
    let reconciliationOutcome: ReconciliationOutcome | undefined;
    let reconciliationFailure: RunSyncResult | undefined;
    if (options.reconciliation && delta && pushMode === "upsert") {
      if (!schemaAtStart.supportedModes.includes("delete")) {
        reconciliationFailure = {
          outcome: "failed",
          error: "delete is not a supported mode for this table; key reconciliation cannot remove rows",
          kind: "schemaDrift",
        };
      } else {
        const keyScanRunId = `${runId}-keyscan`;
        const keyScanSpool = new ReplaceSpoolWriter(spoolDir, keyScanRunId, options.masterKey);
        await keyScanSpool.prepare();

        let keyScanError: unknown;
        try {
          await assertDiskSpace(spoolDir, options.minFreeBytes);
        } catch (err) {
          keyScanError = err;
        }

        if (!keyScanError) {
          const keyScanSignal = combineSignals(options.signal, new AbortController().signal);
          try {
            await options.reconciliation.readKeyScanRows((sourceRow) => {
              keyScanSpool.write(buildKeyRow(formatters, sourceRow, keyTargets));
            }, keyScanSignal);
          } catch (err) {
            keyScanError = err;
          }
          try {
            await keyScanSpool.finish();
          } catch (err) {
            keyScanError = keyScanError ?? err;
          }
        }

        if (keyScanError) {
          await removeReplaceSpool(spoolDir, keyScanRunId);
          reconciliationFailure =
            keyScanError instanceof InsufficientDiskSpaceError ? { outcome: "failed", error: keyScanError.message, kind: "diskSpace" } : toFailure(keyScanError);
        } else {
          const outcome = await computeReconciliation({
            dir: options.dir,
            jobId: job.id,
            masterKey: options.masterKey,
            fingerprint: delta.fingerprint,
            scanSpoolDir: spoolDir,
            scanRunId: keyScanRunId,
            upsertedKeysThisRun,
            maxDeletePercent: options.reconciliation.maxDeletePercent,
            allowMassDelete: options.reconciliation.allowMassDelete,
          });
          await removeReplaceSpool(spoolDir, keyScanRunId);

          if (outcome.guard.tripped) {
            // Deliberate exception to "only the scheduler pauses a job"
            // (jobScheduler.ts's executeWithRetry): a direct CLI `job run`
            // must also be able to pause on a tripped mass-delete guard.
            pauseJobState(job.id, outcome.guard.reason ?? "key reconciliation mass-delete guard tripped", options.dir);
            await outcome.discard();
            reconciliationFailure = { outcome: "failed", error: outcome.guard.reason ?? "mass-delete guard tripped", kind: "massDelete" };
          } else {
            reconciliationOutcome = outcome;
          }
        }
      }
    }

    if (reconciliationFailure) {
      await removeReplaceSpool(spoolDir, runId);
      await removeReplaceSpool(spoolDir, softDeleteRunId);
      if (reconciliationFailure.outcome === "failed") {
        options.logger.error("key_reconciliation_failed", { kind: reconciliationFailure.kind, error: reconciliationFailure.error });
      }
      return reconciliationFailure;
    }

    // Step (e): push — "replace" (unchanged) or "upsert" (slice C1).
    let result: { outcome: "completed"; parts: number; rowCount?: number; version?: number } | { outcome: "failed"; error: string; consoleMessage?: string; kind: RunSyncFailureKind };
    if (pushMode === "upsert") {
      if (totalRows === 0) {
        result = { outcome: "completed", parts: 0 };
      } else {
        result = await upsertPush({
          tableUrl: job.targetUrl,
          pushKey: options.pushKey,
          rows: readReplaceSpool(spoolDir, runId, options.masterKey),
          schemaAtStart,
          logger: options.logger,
          signal: options.signal,
        }).then((r) => (r.outcome === "completed" ? { outcome: "completed" as const, parts: r.parts } : r));
      }
    } else {
      result = await replaceLoad({
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
    }

    // Step (e.5): push this run's computed deletes (upsert-mode
    // reconciliation), or rebuild the saved list directly from the rows
    // just replaced (replace-mode reconciliation, no scan/no deletes).
    // Neither the watermark nor the key list is committed yet in either
    // branch — that happens together, only at the very end (step g),
    // once everything here has succeeded.
    let reconciliationInfo: { deletesSent: number; duplicateKeyCount: number } | undefined;
    let commitKeyList: (() => Promise<void>) | undefined;
    if (result.outcome === "completed" && options.reconciliation && delta) {
      if (pushMode === "replace") {
        const built = await buildReplaceKeyList(options.dir, job.id, options.masterKey, delta.fingerprint, spoolDir, runId, keyTargets);
        if (built.duplicateKeyCount > 0) {
          options.logger.warn("key_reconciliation_duplicate_keys", { duplicateKeyCount: built.duplicateKeyCount });
        }
        commitKeyList = built.commit;
      } else if (reconciliationOutcome) {
        const deleteResult = await deletePush({
          tableUrl: job.targetUrl,
          pushKey: options.pushKey,
          rows: reconciliationOutcome.readDeletes(),
          schemaAtStart,
          logger: options.logger,
          signal: options.signal,
        });
        if (deleteResult.outcome === "failed") {
          await reconciliationOutcome.discard();
          reconciliationFailure = { outcome: "failed", error: deleteResult.error, consoleMessage: deleteResult.consoleMessage, kind: deleteResult.kind };
        } else {
          if (reconciliationOutcome.stats.duplicateKeyCount > 0) {
            options.logger.warn("key_reconciliation_duplicate_keys", { duplicateKeyCount: reconciliationOutcome.stats.duplicateKeyCount });
          }
          reconciliationInfo = { deletesSent: deleteResult.rowsSent, duplicateKeyCount: reconciliationOutcome.stats.duplicateKeyCount };
          commitKeyList = reconciliationOutcome.commit;
        }
      }
    }

    // Step (e.6): push this run's soft-delete rows (§1.2/§10, slice D2) —
    // upserts are pushed first (step e, above), deletes after, same
    // ordering as key reconciliation's own delete push just above. Only
    // runs on an upsert-mode push that actually queued at least one
    // flagged row — a zero-count run, or a replace (which never queues
    // any), sends no delete request at all.
    let softDeleteInfo: { deletesSent: number } | undefined;
    let softDeleteFailure: RunSyncResult | undefined;
    if (result.outcome === "completed" && options.softDelete && pushMode === "upsert" && softDeleteCount > 0) {
      const deleteResult = await deletePush({
        tableUrl: job.targetUrl,
        pushKey: options.pushKey,
        rows: readReplaceSpool(spoolDir, softDeleteRunId, options.masterKey),
        schemaAtStart,
        logger: options.logger,
        signal: options.signal,
      });
      if (deleteResult.outcome === "failed") {
        softDeleteFailure = { outcome: "failed", error: deleteResult.error, consoleMessage: deleteResult.consoleMessage, kind: deleteResult.kind };
      } else {
        softDeleteInfo = { deletesSent: deleteResult.rowsSent };
      }
    }

    // Step (f): the spool is removed on success, failure and abort alike.
    await removeReplaceSpool(spoolDir, runId);
    await removeReplaceSpool(spoolDir, softDeleteRunId);

    if (result.outcome === "failed") {
      options.logger.error("push_failed", { mode: pushMode, error: result.error });
      return result;
    }
    if (reconciliationFailure) {
      if (reconciliationFailure.outcome === "failed") {
        options.logger.error("key_reconciliation_failed", { kind: reconciliationFailure.kind, error: reconciliationFailure.error });
      }
      return reconciliationFailure;
    }
    if (softDeleteFailure) {
      if (softDeleteFailure.outcome === "failed") {
        options.logger.error("soft_delete_failed", { kind: softDeleteFailure.kind, error: softDeleteFailure.error });
      }
      return softDeleteFailure;
    }

    // Step (g): watermark persistence and the key-list commit happen
    // together, right here at the very end — only reached once the push
    // (and, when reconciliation is active, the delete push / replace-mode
    // list rebuild) have all fully succeeded. computeNextWatermark()
    // returning undefined means "leave the saved watermark unchanged" —
    // setLastWatermark must then be skipped entirely, never called with
    // `undefined` (which would actively clear it instead) — but the key
    // list still commits regardless, since the push itself succeeded.
    let watermarkAfter: string | undefined = delta?.savedWatermark;
    if (persistWatermark && delta) {
      const next = computeNextWatermark({
        maxSeen: maxSeenWatermark,
        serverClockAtStart: delta.serverClockAtStart,
        extractionDurationMs,
        overlapSeconds: delta.overlapSeconds,
        isReplace: pushMode === "replace",
      });
      if (next !== undefined) {
        setLastWatermark(job.id, next, delta.fingerprint, options.dir);
        watermarkAfter = next;
      }
    }
    if (commitKeyList) {
      await commitKeyList();
    }

    const durationMs = Date.now() - startedAt;
    options.logger.info("push_completed", {
      mode: pushMode,
      rowsSent: totalRows,
      rowsSkipped: nullKeyCount,
      parts: result.parts,
      durationMs,
      ...(result.rowCount !== undefined ? { rowCount: result.rowCount } : {}),
      ...(result.version !== undefined ? { version: result.version } : {}),
    });

    return {
      outcome: "completed",
      rowsSent: totalRows,
      rowsSkipped: nullKeyCount,
      parts: result.parts,
      durationMs,
      rowCount: result.rowCount,
      version: result.version,
      mode: pushMode,
      watermarkBefore: delta?.savedWatermark,
      watermarkAfter,
      reconciliation: reconciliationInfo,
      softDelete: softDeleteInfo,
    };
  } finally {
    releaseLock?.();
    releaseTable();
  }
}
