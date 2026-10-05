import { randomUUID } from "node:crypto";
import type { PushMode } from "../planometry/types.js";
import { getNextHttpsRunNumber, pauseJobState, setLastWatermark } from "../ops/state.js";
import { computeNextWatermark } from "../sync/watermark.js";
import type { Destination, DestinationRunOptions, DestinationRunResult } from "./destination.js";
import { buildHttpsFormatters, buildHttpsWireRow } from "./httpsFormat.js";
import { sendHttpsBatch, type HttpsAuthConfig } from "./httpsSender.js";

const MAX_BATCH_ROWS = 5_000;
const MAX_BATCH_BYTES = 5 * 1024 * 1024;

export interface HttpsDestinationOptions {
  address: string;
  rowsField?: string;
  auth: HttpsAuthConfig;
}

/**
 * Task item 2: the generic HTTPS destination. Bypasses `sync/runSync.ts`
 * entirely (that module's locking/spool/schema-drift/reconciliation
 * machinery has no equivalent here — there is no target schema, and
 * delete modes + realtime are refused for this type at `job add` time),
 * replicating only the small subset of its logic HTTPS actually needs:
 * watermark tracking while reading rows, push-mode resolution, and the
 * empty-replace guard (mirrored from runSync.ts's own versions of each).
 * Rows are buffered in memory rather than spooled to disk — a deliberate
 * simplification, low-risk given the 5,000-row/5MB batch cap.
 */
export class HttpsDestination implements Destination {
  constructor(private readonly options: HttpsDestinationOptions) {}

  async run(options: DestinationRunOptions): Promise<DestinationRunResult> {
    const { job, sourceColumnTypes, sourceTimeZone, dir, logger, signal, readSourceRows, delta } = options;
    const start = Date.now();
    void logger;

    let formatters;
    try {
      formatters = buildHttpsFormatters(job.mapping, sourceColumnTypes, sourceTimeZone);
    } catch (err) {
      return { outcome: "failed", error: err instanceof Error ? err.message : String(err), kind: "typeMismatch" };
    }

    const rows: Record<string, unknown>[] = [];
    let maxSeenWatermark: string | undefined;

    try {
      await readSourceRows((sourceRow) => {
        if (delta) {
          const raw = sourceRow[delta.watermarkColumn];
          if (typeof raw === "string" && (maxSeenWatermark === undefined || raw > maxSeenWatermark)) {
            maxSeenWatermark = raw;
          }
        }
        rows.push(buildHttpsWireRow(formatters, sourceRow));
      }, signal ?? new AbortController().signal);
    } catch (err) {
      return { outcome: "failed", error: err instanceof Error ? err.message : String(err), kind: "other" };
    }

    // Push-mode resolution — mirrors runSync.ts's (simplified: no key-
    // reconciliation concept here, since deleteMode must be "none" for
    // this destination type).
    let pushMode: PushMode;
    const persistWatermark = delta !== undefined && !delta.isParamOverride;
    if (!delta || delta.isParamOverride) {
      pushMode = delta ? "upsert" : "replace";
    } else {
      pushMode = delta.forceReplace || delta.savedWatermark === undefined ? "replace" : "upsert";
    }

    if (rows.length === 0 && pushMode !== "upsert" && !job.allowEmptyReplace) {
      return {
        outcome: "failed",
        error: "the source table returned zero rows; refusing an empty replace (use --allow-empty-replace to proceed)",
        kind: "emptyReplace",
      };
    }

    // Batch into chunks of at most MAX_BATCH_ROWS rows and MAX_BATCH_BYTES
    // bytes. Zero rows on an "upsert" push sends zero batches (nothing
    // changed — same convention as sync/upsertPush.ts's "zero rows
    // produces zero request parts"); zero rows on a "replace" push still
    // sends one empty batch, so the destination gets the "this is the
    // full, now-empty set" signal.
    const batches: Record<string, unknown>[][] = [];
    if (rows.length > 0) {
      let current: Record<string, unknown>[] = [];
      let currentBytes = 0;
      for (const row of rows) {
        const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8");
        if (current.length > 0 && (current.length >= MAX_BATCH_ROWS || currentBytes + rowBytes > MAX_BATCH_BYTES)) {
          batches.push(current);
          current = [];
          currentBytes = 0;
        }
        current.push(row);
        currentBytes += rowBytes;
      }
      if (current.length > 0) batches.push(current);
    } else if (pushMode === "replace") {
      batches.push([]);
    }

    const runNumber = getNextHttpsRunNumber(job.id, dir);

    for (let i = 0; i < batches.length; i++) {
      const outcome = await sendHttpsBatch({
        url: this.options.address,
        rows: batches[i]!,
        rowsField: this.options.rowsField,
        auth: this.options.auth,
        batchId: randomUUID(),
        runNumber,
        batchNumber: i + 1,
        isLastBatch: i === batches.length - 1,
        signal,
      });

      if (outcome.outcome === "stopAndPause") {
        pauseJobState(job.id, outcome.reason, dir);
        return { outcome: "failed", error: outcome.reason, kind: "config" };
      }
      if (outcome.outcome === "failed") {
        return { outcome: "failed", error: outcome.reason, kind: "transient" };
      }
    }

    let watermarkAfter: string | undefined = delta?.savedWatermark;
    if (persistWatermark && delta) {
      const next = computeNextWatermark({
        maxSeen: maxSeenWatermark,
        serverClockAtStart: delta.serverClockAtStart,
        extractionDurationMs: Date.now() - start,
        overlapSeconds: delta.overlapSeconds,
        isReplace: pushMode === "replace",
      });
      if (next !== undefined) {
        setLastWatermark(job.id, next, delta.fingerprint, dir);
        watermarkAfter = next;
      }
    }

    return {
      outcome: "completed",
      rowsSent: rows.length,
      rowsSkipped: 0,
      parts: batches.length,
      durationMs: Date.now() - start,
      mode: pushMode,
      watermarkBefore: delta?.savedWatermark,
      watermarkAfter,
    };
  }
}
