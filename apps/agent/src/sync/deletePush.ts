import type { Logger } from "../ops/logger.js";
import type { WireRow } from "../planometry/formatForTarget.js";
import { PlanometryClient, PlanometryConfigError, PlanometryRejectedError, PlanometryTransientError } from "../planometry/client.js";
import type { TableSchema } from "../planometry/types.js";
import { backoffDelayMs } from "./chunkUploader.js";
import { buildRequestParts } from "./requestBuilder.js";

const MAX_PART_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 1_000;

export interface DeletePushOptions {
  tableUrl: string;
  pushKey: string;
  caBundlePem?: string;
  timeoutMs?: number;
  /** Key-columns-only wire rows computed by key reconciliation — consumed once. */
  rows: AsyncIterable<WireRow>;
  /** Captured at runSync's getSchema step — only used here for `maxRowsPerRequest`. */
  schemaAtStart: TableSchema;
  logger: Logger;
  signal?: AbortSignal;
}

export type DeletePushFailureKind = "config" | "rejected" | "transient" | "aborted" | "other";

export type DeletePushResult =
  | { outcome: "completed"; parts: number; rowsSent: number }
  | {
      outcome: "failed";
      /** Safe to log — never contains a server-provided message. */
      error: string;
      /** A 400's raw server message, console-only — never pass this to a logger. */
      consoleMessage?: string;
      kind: DeletePushFailureKind;
    };

/**
 * Pushes key reconciliation's computed deletes (docs/plans/
 * planometry-v4-migration.md §1.2/§7, slice D1) as mode `delete`, using
 * the same `rows` request field as upsert/replace (`requestBuilder.ts`'s
 * `deleted` field is `realtime`-only, not usable here). Modeled directly
 * on `upsertPush.ts`: each part stands alone, a transient error retries
 * the same part (up to `MAX_PART_ATTEMPTS`), a 400 stops the run without
 * retrying. Zero rows produces zero request parts — that is success.
 */
export async function deletePush(options: DeletePushOptions): Promise<DeletePushResult> {
  const client = new PlanometryClient({
    tableUrl: options.tableUrl,
    pushKey: options.pushKey,
    caBundlePem: options.caBundlePem,
    timeoutMs: options.timeoutMs,
  });

  function fail(error: string, kind: DeletePushFailureKind, consoleMessage?: string): DeletePushResult {
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
      mode: "delete",
      rows: options.rows,
      schemaRowLimit: options.schemaAtStart.maxRowsPerRequest,
    });

    let partCount = 0;
    let rowsSent = 0;

    for await (const part of parts) {
      partCount += 1;
      if (isAborted()) return fail("run aborted", "aborted");

      let attemptResult: DeletePushResult | undefined;
      for (let attempt = 1; attempt <= MAX_PART_ATTEMPTS; attempt++) {
        if (isAborted()) return fail("run aborted", "aborted");
        try {
          await client.push(part.body);
          options.logger.info("delete_part_accepted", { part: partCount, rows: part.rowCount, attempt });
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
            attemptResult = fail(`transient error retrying a delete part: ${err.message}`, "transient");
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
