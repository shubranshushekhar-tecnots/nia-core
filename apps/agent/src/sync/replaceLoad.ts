import { randomUUID } from "node:crypto";
import type { Logger } from "../ops/logger.js";
import type { WireRow } from "../planometry/formatForTarget.js";
import { PlanometryClient, PlanometryConfigError, PlanometryRejectedError, PlanometryTransientError } from "../planometry/client.js";
import type { TableSchema } from "../planometry/types.js";
import { backoffDelayMs } from "./chunkUploader.js";
import { buildRequestParts, type RequestPart } from "./requestBuilder.js";

/** docs/planometry/connector-guide-v4.md §6b: the last part can take much longer than a middle part (the server does its full key-reconciliation "swap" there) — its own, longer timeout. */
export const DEFAULT_LAST_PART_TIMEOUT_MS = 15 * 60 * 1000;
/** docs/plans/planometry-v4-migration.md §10 slice A4: the agent's own ceiling, not a stated server limit. */
const IDLE_LIMIT_MS = 55 * 60 * 1000;
const LAST_PART_SCHEMA_WAIT_MS = 30_000;
/** One immediate read plus 3 more, each preceded by a 30s wait — 4 reads total. */
const LAST_PART_SCHEMA_EXTRA_READS = 3;
const MAX_MIDDLE_PART_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 1_000;

export interface ReplaceLoadOptions {
  tableUrl: string;
  pushKey: string;
  caBundlePem?: string;
  /** Default/middle-part timeout, passed through to PlanometryClient. */
  timeoutMs?: number;
  /** Defaults to DEFAULT_LAST_PART_TIMEOUT_MS. */
  lastPartTimeoutMs?: number;
  /**
   * Re-reads the already-spooled, already-formatted rows from the top.
   * Called more than once: once to peek whether the load is single- or
   * multi-part, and again (fresh) to actually build and send the real
   * request parts — and again after a restart.
   */
  openRows: () => AsyncIterable<WireRow>;
  /** Rows actually being sent (post null-key filtering) — becomes `totalRows` on the final part. */
  totalRows: number;
  /** Captured at runSync's getSchema step, before any row was read — confirms the load actually landed (its `version` must change). */
  schemaAtStart: TableSchema;
  logger: Logger;
  /** Injectable clock, for the 55-minute idle-limit test. */
  now?: () => Date;
  /** Injectable sleep, for the last-part recovery wait's 30s-x3 test — must run in milliseconds. */
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

/** Mirrors sync/runSync.ts's RunSyncFailureKind — kept local to avoid a circular import (runSync.ts imports this module), re-exported as part of RunSyncFailureKind there. */
export type ReplaceLoadFailureKind = "config" | "rejected" | "transient" | "mismatch" | "aborted" | "other";

export type ReplaceLoadResult =
  | { outcome: "completed"; parts: number; rowCount: number; version: number }
  | {
      outcome: "failed";
      /** Safe to log — never contains a server-provided message. */
      error: string;
      /** A 400's raw server message, console-only — never pass this to a logger. */
      consoleMessage?: string;
      kind: ReplaceLoadFailureKind;
    };

/**
 * Drives one replace load to completion against Planometry (docs/
 * planometry/connector-guide-v4.md §2.3, §3, §6b, §7; docs/plans/
 * planometry-v4-migration.md §10 slice A4, item 3). See the module's
 * design notes in docs/plans/planometry-v4-migration.md §10 (A4) for the
 * full state machine this implements; summarized in each helper below.
 */
export async function replaceLoad(options: ReplaceLoadOptions): Promise<ReplaceLoadResult> {
  const now = options.now ?? (() => new Date());
  let lastAcceptedAt = now();
  let restarted = false;

  const defaultClient = new PlanometryClient({
    tableUrl: options.tableUrl,
    pushKey: options.pushKey,
    caBundlePem: options.caBundlePem,
    timeoutMs: options.timeoutMs,
  });
  const lastPartClient = new PlanometryClient({
    tableUrl: options.tableUrl,
    pushKey: options.pushKey,
    caBundlePem: options.caBundlePem,
    timeoutMs: options.lastPartTimeoutMs ?? DEFAULT_LAST_PART_TIMEOUT_MS,
  });

  function fail(error: string, kind: ReplaceLoadFailureKind, consoleMessage?: string): ReplaceLoadResult {
    return { outcome: "failed", error, consoleMessage, kind };
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  const sleep = options.sleep ?? delay;

  function isAborted(): boolean {
    return options.signal?.aborted === true;
  }

  type MiddleOutcome = { status: "continue" } | { status: "terminal"; result: ReplaceLoadResult };

  async function triggerRestart(): Promise<ReplaceLoadResult> {
    if (restarted) {
      return fail("a mismatch occurred after the one restart this run already used; stopping", "mismatch");
    }
    restarted = true;
    lastAcceptedAt = now();
    options.logger.warn("replace_load_restart", {});
    return sendMultiPart(randomUUID());
  }

  async function sendMiddlePart(part: RequestPart, loadId: string, sentBefore: number): Promise<MiddleOutcome> {
    for (let attempt = 1; attempt <= MAX_MIDDLE_PART_ATTEMPTS; attempt++) {
      if (isAborted()) return { status: "terminal", result: fail("run aborted", "aborted") };
      try {
        const pushResult = await defaultClient.push(part.body);
        const expected = sentBefore + part.rowCount;
        if (pushResult.loadRowsReceived !== expected) {
          return { status: "terminal", result: await triggerRestart() };
        }
        options.logger.info("replace_part_accepted", { loadId, rows: part.rowCount, attempt });
        return { status: "continue" };
      } catch (err) {
        if (err instanceof PlanometryConfigError) {
          return { status: "terminal", result: fail(err.message, "config") };
        }
        if (err instanceof PlanometryRejectedError) {
          return { status: "terminal", result: fail("Planometry rejected the request (status 400)", "rejected", err.message) };
        }
        if (err instanceof PlanometryTransientError) {
          if (attempt < MAX_MIDDLE_PART_ATTEMPTS) {
            await delay(backoffDelayMs(attempt, RETRY_BASE_DELAY_MS));
            continue;
          }
          return { status: "terminal", result: fail(`transient error retrying a middle part: ${err.message}`, "transient") };
        }
        throw err;
      }
    }
    return { status: "terminal", result: fail("middle part failed after all retry attempts", "transient") };
  }

  async function recoverLastPart(part: RequestPart, partCount: number): Promise<ReplaceLoadResult> {
    for (let i = 0; i <= LAST_PART_SCHEMA_EXTRA_READS; i++) {
      if (i > 0) await sleep(LAST_PART_SCHEMA_WAIT_MS);
      let schema: TableSchema;
      try {
        schema = await defaultClient.getSchema();
      } catch {
        continue;
      }
      if (schema.rowCount === options.totalRows && schema.version !== options.schemaAtStart.version) {
        return { outcome: "completed", parts: partCount, rowCount: schema.rowCount, version: schema.version };
      }
    }

    try {
      const pushResult = await lastPartClient.push(part.body);
      if (pushResult.status === "completed") {
        if (pushResult.rowCount !== options.totalRows) {
          return fail(`Planometry reported rowCount ${pushResult.rowCount}, expected ${options.totalRows}`, "mismatch");
        }
        return { outcome: "completed", parts: partCount, rowCount: pushResult.rowCount, version: pushResult.version! };
      }
      return fail("Planometry did not report the load as completed on the resent final part", "mismatch");
    } catch (err) {
      if (err instanceof PlanometryRejectedError) {
        // A 400 on the resend of an already-landed last part means it was double-counted.
        return triggerRestart();
      }
      if (err instanceof PlanometryConfigError) return fail(err.message, "config");
      if (err instanceof PlanometryTransientError) return fail(`transient error resending the final part: ${err.message}`, "transient");
      throw err;
    }
  }

  async function sendLastPart(part: RequestPart, sentBefore: number, partCount: number): Promise<ReplaceLoadResult> {
    try {
      const pushResult = await lastPartClient.push(part.body);
      if (pushResult.status === "completed") {
        if (pushResult.rowCount !== options.totalRows) {
          return fail(`Planometry reported rowCount ${pushResult.rowCount}, expected ${options.totalRows}`, "mismatch");
        }
        return { outcome: "completed", parts: partCount, rowCount: pushResult.rowCount, version: pushResult.version! };
      }
      const expected = sentBefore + part.rowCount;
      if (pushResult.loadRowsReceived !== expected) {
        return triggerRestart();
      }
      return fail("Planometry did not report the load as completed on the final part", "mismatch");
    } catch (err) {
      if (err instanceof PlanometryConfigError) return fail(err.message, "config");
      if (err instanceof PlanometryRejectedError) return fail("Planometry rejected the request (status 400)", "rejected", err.message);
      if (err instanceof PlanometryTransientError) return recoverLastPart(part, partCount);
      throw err;
    }
  }

  async function sendMultiPart(loadId: string): Promise<ReplaceLoadResult> {
    const parts = buildRequestParts({
      mode: "replace",
      rows: options.openRows(),
      schemaRowLimit: options.schemaAtStart.maxRowsPerRequest,
      loadId,
      totalRows: options.totalRows,
    });

    let sentSoFar = 0;
    let partCount = 0;
    for await (const part of parts) {
      partCount += 1;
      if (now().getTime() - lastAcceptedAt.getTime() > IDLE_LIMIT_MS) {
        return fail("more than 55 minutes passed since the last part Planometry accepted; stopping the run", "transient");
      }
      if (isAborted()) return fail("run aborted", "aborted");

      if (part.last) {
        return sendLastPart(part, sentSoFar, partCount);
      }

      const middle = await sendMiddlePart(part, loadId, sentSoFar);
      if (middle.status === "terminal") return middle.result;
      sentSoFar += part.rowCount;
      lastAcceptedAt = now();
    }
    return fail("replace load produced no request parts", "other");
  }

  try {
    const probe = buildRequestParts({
      mode: "replace",
      rows: options.openRows(),
      schemaRowLimit: options.schemaAtStart.maxRowsPerRequest,
      totalRows: options.totalRows,
    });
    const first = await probe.next();
    if (first.done) return fail("replace load produced no request parts", "other");

    if (first.value.last) {
      return await sendLastPart(first.value, 0, 1);
    }
    return await sendMultiPart(randomUUID());
  } finally {
    await defaultClient.close();
    await lastPartClient.close();
  }
}
