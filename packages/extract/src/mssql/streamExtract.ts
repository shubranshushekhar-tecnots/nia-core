import sql from "mssql";
import { NdjsonWriter } from "../ndjsonWriter.js";
import { validateExtractRequest } from "../filterBuilder.js";
import { serializeValue } from "../valueSerializer.js";
import type { Catalog, ExtractRequest } from "../types.js";
import { buildSelectSql } from "./buildSelectSql.js";
import { getColumnNativeTypes } from "./introspect.js";

export interface StreamExtractOptions {
  signal?: AbortSignal;
  /** Row cap, applied as `TOP (n)` in the generated SQL — for previews. */
  limit?: number;
  /**
   * Registers a one-shot "the sink has drained, resume" listener — mirrors
   * Node's `writable.once("drain", listener)`. Required only if `writer`'s
   * underlying `write` callback can return `false` (backed up); omit it
   * for a sink that never backs up (e.g. an in-memory test buffer).
   */
  onDrain?: (listener: () => void) => void;
  /**
   * Aborts the stream as a `TransientExtractError` if no "row" event (and
   * no prior row) has arrived within this long since the query started or
   * the last row, whichever is later. A query that's merely slow but
   * genuinely making progress keeps resetting this; one that's truly
   * stuck (and didn't hit SQL Server's own LOCK_TIMEOUT, e.g. blocked on
   * something other than a row lock) still gets aborted eventually.
   * Defaults to 600_000 (10 minutes).
   */
  noRowsTimeoutMs?: number;
  /**
   * `SET LOCK_TIMEOUT` (milliseconds), bounding how long this query may
   * block waiting on a row/table lock before SQL Server itself aborts it
   * with error 1222 ("Lock request time out period exceeded") — classified
   * below as a `TransientExtractError`. SQL Server's own default is -1
   * (wait indefinitely), which combined with the `requestTimeout: 0`
   * below (disabling tedious's time-to-first-byte timer) means a blocked
   * read would otherwise wait forever.
   *
   * Issued as its own statement prepended to this query's own SQL batch
   * (not a separate request on the pool first) — `mssql`/tedious's
   * connection pool resets session-level `SET` state on every
   * acquire/release cycle, so a `SET` sent as a separate request never
   * survives to the next `.query()` call on the "same" pool. Only a
   * same-batch `SET` is reliable. Defaults to 300_000 (5 minutes).
   */
  lockTimeoutMs?: number;
  /**
   * Reports the raw `Error` for a terminal failure, synchronously, right
   * before it's serialized to the wire via `writer.writeError`. The
   * NDJSON wire protocol only carries a plain string, which loses the
   * error's class (e.g. `TransientExtractError`) — a same-process caller
   * (apps/agent) uses this to recover that identity instead of matching
   * on message text. Never called on success or abort.
   */
  onError?: (err: unknown) => void;
}

/**
 * A clean, retryable extraction failure — the request was cancelled and
 * the connection released, not left stuck. Covers SQL Server's own
 * `LOCK_TIMEOUT` expiring (error 1222, "Lock request time out period
 * exceeded" — see connection.ts's `lockTimeoutMs`) and this module's own
 * no-rows watchdog (`noRowsTimeoutMs`) tripping.
 */
export class TransientExtractError extends Error {}

/** SQL Server's error number for a session's `LOCK_TIMEOUT` expiring mid-request. Exported for extractKeysetBatch.ts's own (non-streaming) use of the same classification. */
export const SQL_LOCK_TIMEOUT_ERROR_NUMBER = 1222;

/**
 * Validates `request` against `catalog`, builds one parameterized SELECT,
 * and streams every row through `writer` as NDJSON — never buffering the
 * full result set (mssql's `request.stream = true` + pause/resume
 * back-pressure below). On any mid-stream failure, writes `{"error":...}`
 * and stops (no trailer); on success, writes the `{"end":true,"rows":N}`
 * trailer. Never throws past this function for a query-time failure —
 * failures are reported on the wire via `writer.writeError`, matching
 * the "Rows" protocol in docs/plans/planometry-integration.md. A
 * request-shape failure (unknown table/column/operator, bad filter) is
 * thrown before anything is written, so the caller can respond before
 * the stream protocol begins.
 */
export async function streamExtract(pool: sql.ConnectionPool, catalog: Catalog, request: ExtractRequest, writer: NdjsonWriter, options: StreamExtractOptions = {}): Promise<void> {
  const { table, columns } = validateExtractRequest(catalog, request);
  const nativeTypes = await getColumnNativeTypes(pool, table.name);
  const { sql: selectSql, params } = buildSelectSql(table, nativeTypes, columns, request.filter, options.limit);
  // Same-batch SET (see StreamExtractOptions.lockTimeoutMs's doc comment) —
  // a plain SELECT with no leading statement, so prepending this is safe.
  const lockTimeoutMs = options.lockTimeoutMs ?? 300_000;
  const sqlText = `SET LOCK_TIMEOUT ${lockTimeoutMs};\n${selectSql}`;

  const columnTypes = columns.map((name) => {
    const col = table.columns.find((c) => c.name === name);
    if (!col) throw new Error(`streamExtract: resolved column ${JSON.stringify(name)} missing from catalog table ${JSON.stringify(table.name)}`);
    return col;
  });

  writer.writeColumns(columnTypes.map((c) => ({ name: c.name, type: c.type })));
  writer.startKeepAlive();

  // mssql/tedious's requestTimeout (15s default, unset anywhere in
  // connection.ts) is a time-to-first-byte timer — it's cleared the moment
  // the first response packet arrives (tedious/lib/connection.js,
  // SentClientRequest.enter), not a cap on total query duration. A
  // streaming extract can legitimately sit fully blocked (e.g. a lock wait
  // behind a concurrent writer) for longer than 15s before its first row,
  // so it must not inherit that short default. Short single-value queries
  // (watermark.ts's readServerClock/checkWatermarkColumn) are unaffected —
  // they keep the pool's default short timeout.
  // @types/mssql doesn't declare the `overrides` constructor arg that the
  // runtime `mssql` package actually accepts (lib/base/request.js), so the
  // second argument is typed via a local constructor shape instead of `any`.
  type RequestWithOverrides = new (connection: sql.ConnectionPool, overrides?: { requestTimeout?: number }) => sql.Request;
  const sqlRequest = new (sql.Request as unknown as RequestWithOverrides)(pool, { requestTimeout: 0 });
  sqlRequest.stream = true;
  for (let i = 0; i < params.length; i++) {
    sqlRequest.input(`p${i + 1}`, params[i]);
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    let aborted = false;
    let noRowsTimer: ReturnType<typeof setTimeout> | undefined;
    const noRowsTimeoutMs = options.noRowsTimeoutMs ?? 600_000;

    const onAbort = () => {
      aborted = true;
      sqlRequest.cancel();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (err?: unknown) => {
      if (settled) return;
      settled = true;
      if (noRowsTimer) clearTimeout(noRowsTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (err && !aborted) {
        options.onError?.(err);
        writer.writeError(err instanceof Error ? err.message : String(err));
      } else if (!aborted) {
        writer.writeEnd();
      } else {
        // Aborted: close the wire without a trailer, same as any other mid-stream failure.
        writer.writeError("aborted");
      }
      resolve();
    };

    // No-rows watchdog (StreamExtractOptions.noRowsTimeoutMs's doc
    // comment) — (re)armed below, right after the query is sent and on
    // every row, so it always measures "since the last sign of progress".
    const armNoRowsTimer = () => {
      if (noRowsTimer) clearTimeout(noRowsTimer);
      noRowsTimer = setTimeout(() => {
        if (!aborted) sqlRequest.cancel();
        finish(new TransientExtractError(`no rows received within ${noRowsTimeoutMs}ms`));
      }, noRowsTimeoutMs);
    };

    sqlRequest.on("row", (row: Record<string, unknown>) => {
      armNoRowsTimer();
      try {
        const values = columnTypes.map((c) => serializeValue(c.type, row[c.name]));
        const ok = writer.writeRow(values);
        if (!ok) {
          // Back-pressure: the sink is backed up. Pause the driver (it
          // buffers nothing further internally while paused) and resume
          // only once notified the sink has drained — never buffer rows
          // ourselves to ride out a slow consumer.
          sqlRequest.pause();
          options.onDrain?.(() => sqlRequest.resume());
        }
      } catch (err) {
        // A bad value shouldn't be possible if introspection/casting are
        // correct, but never let a single malformed row crash the
        // process — surface it as the stream's terminal error instead.
        sqlRequest.cancel();
        finish(err);
      }
    });
    sqlRequest.on("error", (err: unknown) => {
      // Release the connection cleanly on any failure, not just abort/a
      // malformed row — mirrors the catch block above.
      if (!aborted) sqlRequest.cancel();
      const isLockTimeout = err instanceof Error && (err as Error & { number?: number }).number === SQL_LOCK_TIMEOUT_ERROR_NUMBER;
      finish(isLockTimeout ? new TransientExtractError((err as Error).message) : err);
    });
    sqlRequest.on("done", () => finish());

    armNoRowsTimer();
    sqlRequest.query(sqlText);
  });
}
