import type { ExtractType } from "./types.js";

export interface NdjsonColumn {
  name: string;
  type: ExtractType;
}

/**
 * NDJSON row-stream writer, transport-agnostic (takes a plain `write`
 * callback so it can be wired to an HTTP response, a socket, or a test
 * buffer alike — keeping it usable from an on-premise agent later).
 *
 * Protocol (docs/plans/planometry-integration.md "Rows"):
 *   line 1   {"columns":[{name,type}…]}          — writeColumns, immediate
 *   lines 2+ [v1, v2, …]                          — writeRow, one per row
 *   (blank)                                       — keep-alive, >=1/30s while waiting
 *   last     {"end":true,"rows":N}                — writeEnd, success only
 *   or       {"error":"…"}                        — writeError, failure, no trailer
 */
export class NdjsonWriter {
  private rowCount = 0;
  private closed = false;
  private lastActivity = Date.now();
  private keepAliveTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * `write` mirrors Node's `Writable.write()` contract: return `false` to
   * signal the sink is backed up (e.g. a socket's internal buffer is
   * full) so the caller can pause pulling more rows — streamExtract.ts
   * uses this to drive `request.pause()`/`request.resume()` so a slow
   * consumer never forces unbounded buffering. Returning `true` (or
   * `void`, for a sink that never backs up, e.g. an in-memory test
   * buffer) means "keep going".
   */
  constructor(
    private readonly write: (chunk: string) => boolean | void,
    private readonly keepAliveIntervalMs = 30_000,
  ) {}

  writeColumns(columns: NdjsonColumn[]): boolean {
    this.assertOpen();
    return this.emit(JSON.stringify({ columns }));
  }

  writeRow(values: unknown[]): boolean {
    this.assertOpen();
    const ok = this.emit(JSON.stringify(values));
    this.rowCount += 1;
    return ok;
  }

  writeEnd(): void {
    this.assertOpen();
    this.emit(JSON.stringify({ end: true, rows: this.rowCount }));
    this.close();
  }

  writeError(message: string): void {
    this.assertOpen();
    this.emit(JSON.stringify({ error: message }));
    this.close();
  }

  /** Starts a timer that emits a blank keep-alive line whenever >=keepAliveIntervalMs has elapsed since the last emitted line (i.e. only while genuinely waiting, not on every tick). Call `stopKeepAlive()` (or `writeEnd`/`writeError`, which call it) when done. */
  startKeepAlive(checkIntervalMs = 1_000): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (this.closed) return;
      if (Date.now() - this.lastActivity >= this.keepAliveIntervalMs) {
        this.write("\n");
        this.lastActivity = Date.now();
      }
    }, checkIntervalMs);
  }

  stopKeepAlive(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = undefined;
  }

  private emit(line: string): boolean {
    const ok = this.write(line + "\n");
    this.lastActivity = Date.now();
    return ok !== false;
  }

  private close(): void {
    this.stopKeepAlive();
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("NdjsonWriter: already closed (writeEnd/writeError already called)");
  }
}
