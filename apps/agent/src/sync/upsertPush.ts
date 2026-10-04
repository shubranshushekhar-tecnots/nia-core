import type { Logger } from "../ops/logger.js";
import type { WireRow } from "../planometry/formatForTarget.js";
import { PlanometryClient, PlanometryConfigError, PlanometryRejectedError, PlanometryTransientError } from "../planometry/client.js";
import type { TableSchema } from "../planometry/types.js";
import { backoffDelayMs } from "./chunkUploader.js";
import { buildRequestParts } from "./requestBuilder.js";

const MAX_PART_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 1_000;

export interface UpsertPushOptions {
  tableUrl: string;
  pushKey: string;
  caBundlePem?: string;
  timeoutMs?: number;
  /** Already-mapped, already-formatted wire rows for this run — consumed once. */
  rows: AsyncIterable<WireRow>;
  /** Captured at runSync's getSchema step — only used here for `maxRowsPerRequest`. */
  schemaAtStart: TableSchema;
  logger: Logger;
  signal?: AbortSignal;
}

export type UpsertPushFailureKind = "config" | "rejected" | "transient" | "aborted" | "other";

export type UpsertPushResult =
  | { outcome: "completed"; parts: number; rowsSent: number }
  | {
      outcome: "failed";
      /** Safe to log — never contains a server-provided message. */
      error: string;
      /** A 400's raw server message, console-only — never pass this to a logger. */
      consoleMessage?: string;
      kind: UpsertPushFailureKind;
    };

/**
 * Pushes one `upsertDelta` run's rows as mode `upsert` (docs/planometry/
 * connector-guide-v4.md §3: "stateless and idempotent ... re-sending the
 * same request is harmless"). Unlike `replaceLoad.ts`, each part stands
 * entirely alone — no `loadId`/`last`/`totalRows` lifecycle, no restart
 * logic, no row-count-mismatch bookkeeping between parts. A transient
 * error retries the same part (up to `MAX_PART_ATTEMPTS`, same backoff as
 * `replaceLoad.ts`'s middle parts); a 400 (`PlanometryRejectedError`)
 * stops the run without retrying it. Zero rows produces zero request
 * parts — that is success, not an error (task item 4).
 */
export async function upsertPush(options: UpsertPushOptions): Promise<UpsertPushResult> {
  const client = new PlanometryClient({
    tableUrl: options.tableUrl,
    pushKey: options.pushKey,
    caBundlePem: options.caBundlePem,
    timeoutMs: options.timeoutMs,
  });

  function fail(error: string, kind: UpsertPushFailureKind, consoleMessage?: string): UpsertPushResult {
    return { outcome: "failed", error, consoleMessage, kind };
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isAborted(): boolean {
    return options.signal?.aborted === true;
  }

  try {
    const parts = buildRequestParts({
      mode: "upsert",
      rows: options.rows,
      schemaRowLimit: options.schemaAtStart.maxRowsPerRequest,
    });

    let partCount = 0;
    let rowsSent = 0;

    for await (const part of parts) {
      partCount += 1;
      if (isAborted()) return fail("run aborted", "aborted");

      let attemptResult: UpsertPushResult | undefined;
      for (let attempt = 1; attempt <= MAX_PART_ATTEMPTS; attempt++) {
        if (isAborted()) return fail("run aborted", "aborted");
        try {
          await client.push(part.body);
          options.logger.info("upsert_part_accepted", { part: partCount, rows: part.rowCount, attempt });
          rowsSent += part.rowCount;
          attemptResult = undefined;
          break;
        } catch (err) {
          if (err instanceof PlanometryConfigError) {
            attemptResult = fail(err.message, "config");
            break;
          }
          if (err instanceof PlanometryRejectedError) {
            attemptResult = fail("Planometry rejected the request (status 400)", "rejected", err.message);
            break;
          }
          if (err instanceof PlanometryTransientError) {
            if (attempt < MAX_PART_ATTEMPTS) {
              await delay(backoffDelayMs(attempt, RETRY_BASE_DELAY_MS));
              continue;
            }
            attemptResult = fail(`transient error retrying an upsert part: ${err.message}`, "transient");
            break;
          }
          throw err;
        }
      }
      if (attemptResult) return attemptResult;
    }

    return { outcome: "completed", parts: partCount, rowsSent };
  } finally {
    await client.close();
  }
}
