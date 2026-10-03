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
}

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
  const { sql: sqlText, params } = buildSelectSql(table, nativeTypes, columns, request.filter, options.limit);

  const columnTypes = columns.map((name) => {
    const col = table.columns.find((c) => c.name === name);
    if (!col) throw new Error(`streamExtract: resolved column ${JSON.stringify(name)} missing from catalog table ${JSON.stringify(table.name)}`);
    return col;
  });

  writer.writeColumns(columnTypes.map((c) => ({ name: c.name, type: c.type })));
  writer.startKeepAlive();

  const sqlRequest = new sql.Request(pool);
  sqlRequest.stream = true;
  for (let i = 0; i < params.length; i++) {
    sqlRequest.input(`p${i + 1}`, params[i]);
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      sqlRequest.cancel();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (err?: unknown) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      if (err && !aborted) {
        writer.writeError(err instanceof Error ? err.message : String(err));
      } else if (!aborted) {
        writer.writeEnd();
      } else {
        // Aborted: close the wire without a trailer, same as any other mid-stream failure.
        writer.writeError("aborted");
      }
      resolve();
    };

    sqlRequest.on("row", (row: Record<string, unknown>) => {
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
    sqlRequest.on("error", (err: unknown) => finish(err));
    sqlRequest.on("done", () => finish());

    sqlRequest.query(sqlText);
  });
}
