import { randomUUID } from "node:crypto";
import type { ExtractType } from "@nia/extract";
import type { SyncJobEntry } from "../config/types.js";
import type { Logger } from "../ops/logger.js";
import { pauseJobState, setLastWatermark } from "../ops/state.js";
import { buildKeyRow, buildWireRow, FormatForTargetError, type MappedColumnFormatter, type WireRow } from "../planometry/formatForTarget.js";
import { PlanometryClient, PlanometryConfigError, PlanometryRejectedError, PlanometryTransientError } from "../planometry/client.js";
import { backoffDelayMs } from "./chunkUploader.js";
import { addKeysToSavedList, canonicalKeyString, computeReconciliation, type ReconciliationOutcome } from "./keyReconciliation.js";
import { buildFormatters } from "./runSync.js";
import { isSoftDeletedRow } from "./softDelete.js";
import { buildRequestParts } from "./requestBuilder.js";
import { readReplaceSpool, removeReplaceSpool, ReplaceSpoolWriter } from "./replaceSpool.js";
import { computeNextWatermark } from "./watermark.js";

const MAX_PART_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 1_000;

/**
 * `strategy: "realtime"` only (docs/plans/planometry-v4-migration.md §1.3,
 * §10 slice E1): one tick of a short repeating cycle that sends upserts
 * and deletes together in mode `realtime`. Called only when a valid
 * saved watermark already exists — `cli/runJobCommand.ts` routes a
 * realtime job with no valid saved watermark (or `job run --replace`)
 * straight to `runSync` instead, exactly like `upsertDelta`'s first-run/
 * forced-replace path (its existing pushMode resolution + `replaceLoad`/
 * `buildReplaceKeyList` already do the right thing unchanged).
 *
 * Reuses `upsertDelta`'s formatter/key-row building (`runSync.ts`'s
 * `buildFormatters`, `formatForTarget.ts`'s `buildWireRow`/`buildKeyRow`),
 * `softDelete.ts`'s flag-column check, and `keyReconciliation.ts`'s
 * bucketed saved-list machinery (`computeReconciliation` on a reconciling
 * tick, the new `addKeysToSavedList` on a tick that only upserts).
 */
export interface RealtimeTickOptions {
  job: SyncJobEntry;
  /** Resolved from the job's pushKeyRef via the local secret store — never logged. */
  pushKey: string;
  sourceColumnTypes: Record<string, ExtractType>;
  sourceTimeZone?: string;
  /** Agent home dir (config/paths.ts) — key-list/spool paths are derived from this. */
  dir: string;
  masterKey: Buffer;
  logger: Logger;
  signal?: AbortSignal;
  caBundlePem?: string;
  timeoutMs?: number;
  runId?: string;
  /**
   * Two-pass (`gte` + `isNull` against `watermarkColumn`) changed-row
   * reader — the same shape `cli/runJobCommand.ts` already builds for an
   * `upsertDelta` delta run, composed into a single callback here.
   */
  readChangedRows: (onRow: (row: Record<string, unknown>) => void, signal: AbortSignal) => Promise<void>;
  watermarkColumn: string;
  overlapSeconds: number;
  /** Already resolved+fingerprint-checked by the caller — always defined (a tick is never a bootstrap replace). */
  savedWatermark: string;
  /** Read via `readServerClock()` before extraction starts (`S` in the watermark formula). */
  serverClockAtStart: string;
  /** `sync/watermark.ts`'s `computeJobFingerprint(job)` — saved alongside the watermark, and alongside the key list, on success. */
  fingerprint: string;
  /** `job.deleteMode === "softDelete"` only — a flagged changed row is sent as a delete instead of an upsert, every tick. */
  softDelete?: { column: string };
  /** `job.deleteMode === "reconciliation"` only. */
  reconciliation?: {
    /** Decided by the caller from `reconciliationIntervalSeconds` vs. the saved `lastRealtimeReconciledAt` — true runs the full key-list comparison this tick; false just appends this tick's upserted keys to the saved list. */
    shouldReconcile: boolean;
    readKeyScanRows: (onRow: (row: Record<string, unknown>) => void, signal: AbortSignal) => Promise<void>;
    maxDeletePercent: number;
    allowMassDelete: boolean;
  };
}

export type RealtimeTickFailureKind = "config" | "rejected" | "transient" | "aborted" | "massDelete" | "other";

export type RealtimeTickResult =
  | {
      outcome: "completed";
      /** Number of realtime request parts actually sent (0 for an empty tick — nothing changed and nothing was deleted). */
      parts: number;
      rowsUpserted: number;
      rowsDeleted: number;
      watermarkAfter: string;
      /** True when the key-list comparison ran this tick (vs. just appending to the saved list). Unset when `deleteMode !== "reconciliation"`. */
      reconciled?: boolean;
      /** True when the tick sent no request at all (task item 3, scheduler/jobScheduler.ts's "empty ticks are not written to the log file"). */
      empty: boolean;
    }
  | {
      outcome: "failed";
      /** Safe to log — never contains a server-provided message. */
      error: string;
      /** A 400's raw server message, console-only — never pass this to a logger. */
      consoleMessage?: string;
      kind: RealtimeTickFailureKind;
    };

function toFailure(err: unknown): RealtimeTickResult {
  if (err instanceof PlanometryConfigError) return { outcome: "failed", error: err.message, kind: "config" };
  if (err instanceof PlanometryRejectedError) {
    return { outcome: "failed", error: "Planometry rejected the request (status 400)", consoleMessage: err.message, kind: "rejected" };
  }
  if (err instanceof PlanometryTransientError) return { outcome: "failed", error: `transient error: ${err.message}`, kind: "transient" };
  if (err instanceof FormatForTargetError) return { outcome: "failed", error: err.message, kind: "other" };
  if (err instanceof Error) return { outcome: "failed", error: err.message, kind: "other" };
  return { outcome: "failed", error: String(err), kind: "other" };
}

async function* fromArray<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

export async function realtimeTick(options: RealtimeTickOptions): Promise<RealtimeTickResult> {
  const startedAt = Date.now();
  const { job } = options;
  const runId = options.runId ?? randomUUID();

  if (options.signal?.aborted) return { outcome: "failed", error: "run aborted", kind: "aborted" };

  const client = new PlanometryClient({
    tableUrl: job.targetUrl,
    pushKey: options.pushKey,
    caBundlePem: options.caBundlePem,
    timeoutMs: options.timeoutMs,
  });

  try {
    let schemaAtStart;
    try {
      schemaAtStart = await client.getSchema();
    } catch (err) {
      return toFailure(err);
    }
    if (!schemaAtStart.supportedModes.includes("realtime")) {
      return { outcome: "failed", error: "realtime is no longer a supported mode for this table", kind: "config" };
    }

    let formatters: MappedColumnFormatter[];
    try {
      formatters = buildFormatters(job, options.sourceColumnTypes, options.sourceTimeZone);
    } catch (err) {
      if (err instanceof FormatForTargetError) return { outcome: "failed", error: err.message, kind: "other" };
      throw err;
    }
    const keyTargets = job.targetSchemaSnapshot.keyColumns;

    // Per-key collapse (§1.3 item 2): a key seen more than once among the
    // changed rows (e.g. the `gte` and `isNull` passes can never overlap,
    // but defensively collapsing by key is cheap and correct either way)
    // keeps only the latest wire row under its canonical key string.
    const upserts = new Map<string, WireRow>();
    const deletedByKey = new Map<string, WireRow>();
    let maxSeenWatermark: string | undefined;

    const extractionStartedAt = Date.now();
    try {
      await options.readChangedRows((sourceRow) => {
        if (options.signal?.aborted) return;
        const raw = sourceRow[options.watermarkColumn];
        if (typeof raw === "string" && (maxSeenWatermark === undefined || raw > maxSeenWatermark)) {
          maxSeenWatermark = raw;
        }
        if (options.softDelete && isSoftDeletedRow(sourceRow, options.softDelete.column)) {
          const keyRow = buildKeyRow(formatters, sourceRow, keyTargets);
          deletedByKey.set(canonicalKeyString(keyRow), keyRow);
          return;
        }
        const wireRow = buildWireRow(formatters, sourceRow);
        const keyRow: WireRow = {};
        for (const k of keyTargets) keyRow[k] = wireRow[k] ?? null;
        upserts.set(canonicalKeyString(keyRow), wireRow);
      }, options.signal ?? new AbortController().signal);
    } catch (err) {
      return toFailure(err);
    }
    const extractionDurationMs = Date.now() - extractionStartedAt;

    if (options.signal?.aborted) return { outcome: "failed", error: "run aborted", kind: "aborted" };

    // Key reconciliation (§1.2/§1.3, slice D1 reused for E1): only on a
    // tick where the reconciliation interval has elapsed (decided by the
    // caller). Scan + guard runs entirely BEFORE any push request for
    // this tick is sent, same ordering as D1.
    let reconciliationOutcome: ReconciliationOutcome | undefined;
    if (options.reconciliation?.shouldReconcile) {
      if (!schemaAtStart.supportedModes.includes("delete")) {
        return { outcome: "failed", error: "delete is not a supported mode for this table; key reconciliation cannot remove rows", kind: "config" };
      }
      const keyScanRunId = `${runId}-keyscan`;
      const keyScanSpool = new ReplaceSpoolWriter(options.dir, keyScanRunId, options.masterKey);
      await keyScanSpool.prepare();
      try {
        await options.reconciliation.readKeyScanRows((sourceRow) => {
          keyScanSpool.write(buildKeyRow(formatters, sourceRow, keyTargets));
        }, options.signal ?? new AbortController().signal);
        await keyScanSpool.finish();
      } catch (err) {
        await removeReplaceSpool(options.dir, keyScanRunId);
        return toFailure(err);
      }

      const upsertedKeysThisRun = new Set(upserts.keys());
      const outcome = await computeReconciliation({
        dir: options.dir,
        jobId: job.id,
        masterKey: options.masterKey,
        fingerprint: options.fingerprint,
        scanSpoolDir: options.dir,
        scanRunId: keyScanRunId,
        upsertedKeysThisRun,
        maxDeletePercent: options.reconciliation.maxDeletePercent,
        allowMassDelete: options.reconciliation.allowMassDelete,
      });
      await removeReplaceSpool(options.dir, keyScanRunId);

      if (outcome.guard.tripped) {
        // Same deliberate exception as runSync.ts: the mass-delete guard
        // pauses the job directly, not just via the scheduler.
        pauseJobState(job.id, outcome.guard.reason ?? "key reconciliation mass-delete guard tripped", options.dir);
        await outcome.discard();
        return { outcome: "failed", error: outcome.guard.reason ?? "mass-delete guard tripped", kind: "massDelete" };
      }
      reconciliationOutcome = outcome;
      for await (const row of outcome.readDeletes()) {
        deletedByKey.set(canonicalKeyString(row), row);
      }
    }

    // Guard (§1.3 item 2): a key present in both the changed rows and the
    // deleted keys is sent only in deleted. Reconciliation's own diff
    // already excludes this run's upserted keys from its computed
    // deletes, and a softDelete-flagged row never enters `upserts` to
    // begin with — this final pass is a defensive, explicit guarantee
    // regardless of which path produced the overlap.
    for (const key of deletedByKey.keys()) upserts.delete(key);

    const rowsUpserted = upserts.size;
    const rowsDeleted = deletedByKey.size;
    const empty = rowsUpserted === 0 && rowsDeleted === 0;

    let partCount = 0;
    if (!empty) {
      const parts = buildRequestParts({
        mode: "realtime",
        rows: fromArray([...upserts.values()]),
        deleted: fromArray([...deletedByKey.values()]),
        schemaRowLimit: schemaAtStart.maxRowsPerRequest,
      });

      for await (const part of parts) {
        partCount += 1;
        if (options.signal?.aborted) {
          await reconciliationOutcome?.discard();
          return { outcome: "failed", error: "run aborted", kind: "aborted" };
        }

        let attemptResult: RealtimeTickResult | undefined;
        for (let attempt = 1; attempt <= MAX_PART_ATTEMPTS; attempt++) {
          if (options.signal?.aborted) {
            attemptResult = { outcome: "failed", error: "run aborted", kind: "aborted" };
            break;
          }
          try {
            await client.push(part.body);
            options.logger.info("realtime_part_accepted", { part: partCount, rows: part.rowCount, attempt });
            attemptResult = undefined;
            break;
          } catch (err) {
            if (err instanceof PlanometryConfigError) {
              attemptResult = toFailure(err);
              break;
            }
            if (err instanceof PlanometryRejectedError) {
              attemptResult = toFailure(err);
              break;
            }
            if (err instanceof PlanometryTransientError) {
              if (attempt < MAX_PART_ATTEMPTS) {
                await new Promise((resolve) => setTimeout(resolve, backoffDelayMs(attempt, RETRY_BASE_DELAY_MS)));
                continue;
              }
              attemptResult = { outcome: "failed", error: `transient error retrying a realtime part: ${err.message}`, kind: "transient" };
              break;
            }
            throw err;
          }
        }
        if (attemptResult) {
          await reconciliationOutcome?.discard();
          return attemptResult;
        }
      }
    }

    // Saved-list maintenance (§1.3 item 5): only after the tick's requests
    // have all succeeded. A reconciling tick commits its freshly computed
    // list; a non-reconciling tick (deleteMode "reconciliation" only)
    // instead appends this tick's upserted keys to the existing list so a
    // later reconciling tick's `saved - currentScan` diff doesn't treat
    // them as deleted.
    let reconciled: boolean | undefined;
    if (reconciliationOutcome) {
      await reconciliationOutcome.commit();
      reconciled = true;
    } else if (options.reconciliation) {
      const appended = await addKeysToSavedList(options.dir, job.id, options.masterKey, options.fingerprint, new Set(upserts.keys()));
      await appended.commit();
      reconciled = false;
    }

    // Watermark persistence (§1.1's formula, reused as-is) — only after
    // everything above has succeeded.
    const next = computeNextWatermark({
      maxSeen: maxSeenWatermark,
      serverClockAtStart: options.serverClockAtStart,
      extractionDurationMs,
      overlapSeconds: options.overlapSeconds,
      isReplace: false,
    });
    const watermarkAfter = next ?? options.savedWatermark;
    if (next !== undefined) {
      setLastWatermark(job.id, next, options.fingerprint, options.dir);
    }

    if (!empty) {
      const durationMs = Date.now() - startedAt;
      options.logger.info("realtime_tick_completed", { parts: partCount, rowsUpserted, rowsDeleted, durationMs, reconciled: reconciled ?? false });
    }

    return { outcome: "completed", parts: partCount, rowsUpserted, rowsDeleted, watermarkAfter, reconciled, empty };
  } finally {
    await client.close();
  }
}
