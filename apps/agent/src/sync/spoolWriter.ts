import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

export interface SpoolChunkFile {
  seq: number;
  path: string;
  rows: number;
}

export type SpoolResult = { ok: true; totalRows: number } | { ok: false; error: string };

export interface SpoolWriterOptions {
  /** Row threshold per chunk file (Phase 2 §4: "<=50,000 rows"). */
  maxRows?: number;
  /**
   * Uncompressed-byte threshold per chunk file (Phase 2 §4: "<=16MB
   * each"). Measured pre-gzip — the true compressed size isn't known
   * until a file is flushed/closed, so this is a deliberate, conservative
   * simplification: a chunk this ever rotates on will always compress to
   * well under 16MB in practice for NDJSON row data.
   */
  maxBytes?: number;
}

const DEFAULT_MAX_ROWS = 50_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Implements the `write` callback contract `NdjsonWriter` expects
 * (`Writable.write()`-style boolean backpressure: see
 * packages/extract/src/ndjsonWriter.ts), spooling each NDJSON line
 * `streamExtract` emits to a rotating sequence of gzip chunk files on
 * disk under `dir` (Phase 2 §4: "spool to disk ... closes the query,
 * then uploads from disk").
 *
 * Every chunk file is self-contained NDJSON — it repeats the columns
 * header line — so a chunk can be retried/uploaded independently of its
 * siblings. The stream's own `{end,rows}`/`{error}` trailer line is
 * *not* written into chunk content: completion/failure is reported to
 * Planometry via separate `reportComplete`/`reportFailed` calls (Slice
 * c), so embedding it in the uploaded bytes would be redundant. Instead
 * the trailer is captured here and returned from `finish()` for the
 * sync executor to act on.
 */
export class SpoolWriter {
  private readonly maxRows: number;
  private readonly maxBytes: number;
  private columnsLine: string | undefined;
  private seq = 0;
  private currentGzip: zlib.Gzip | undefined;
  private currentFileStream: ReturnType<typeof createWriteStream> | undefined;
  private currentRows = 0;
  private currentBytes = 0;
  private readonly files: SpoolChunkFile[] = [];
  private readonly pendingCloses: Promise<void>[] = [];
  private drainListener: (() => void) | undefined;
  private result: SpoolResult | undefined;

  constructor(
    private readonly dir: string,
    private readonly runId: string,
    options: SpoolWriterOptions = {},
  ) {
    this.maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async prepare(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /** Pass as `NdjsonWriter`'s `write` callback. */
  write = (chunk: string): boolean => {
    if (chunk === "\n") {
      // Keep-alive: no row/header/trailer semantics, nothing to persist.
      return true;
    }

    const parsed = JSON.parse(chunk) as unknown;

    if (Array.isArray(parsed)) {
      this.ensureStream();
      const ok = this.writeToStream(chunk);
      this.currentRows += 1;
      this.files[this.files.length - 1]!.rows = this.currentRows;
      if (this.currentRows >= this.maxRows || this.currentBytes >= this.maxBytes) {
        this.closeCurrent();
      }
      return ok;
    }

    const obj = parsed as { columns?: unknown; end?: true; rows?: number; error?: string };
    if (obj.columns !== undefined) {
      this.columnsLine = chunk;
      return true;
    }

    if (obj.end === true) {
      this.result = { ok: true, totalRows: obj.rows ?? 0 };
    } else {
      this.result = { ok: false, error: obj.error ?? "unknown extract error" };
    }
    return true;
  };

  /** Pass as `StreamExtractOptions.onDrain`. */
  onDrain(listener: () => void): void {
    this.drainListener = listener;
  }

  /** Call once `streamExtract`'s promise has resolved. Flushes and closes any still-open chunk file, waits for every file to finish writing to disk. */
  async finish(): Promise<{ files: SpoolChunkFile[]; result: SpoolResult }> {
    this.closeCurrent();
    await Promise.all(this.pendingCloses);
    return { files: this.files, result: this.result ?? { ok: false, error: "extract ended without a trailer" } };
  }

  private ensureStream(): void {
    if (this.currentGzip) return;
    // 0-based, matching the CHUNK_SEQ_HEADER convention used throughout
    // planometry/client.ts and its tests.
    const seq = this.seq;
    this.seq += 1;
    const filePath = path.join(this.dir, `${this.runId}.${String(seq).padStart(5, "0")}.ndjson.gz`);
    const fileStream = createWriteStream(filePath);
    const gzip = zlib.createGzip();
    gzip.pipe(fileStream);
    gzip.on("drain", () => this.drainListener?.());
    this.currentGzip = gzip;
    this.currentFileStream = fileStream;
    this.currentRows = 0;
    this.currentBytes = 0;
    this.files.push({ seq, path: filePath, rows: 0 });
    if (this.columnsLine) this.writeToStream(this.columnsLine);
  }

  private writeToStream(line: string): boolean {
    this.currentBytes += Buffer.byteLength(line);
    return this.currentGzip!.write(line) !== false;
  }

  private closeCurrent(): void {
    if (!this.currentGzip || !this.currentFileStream) return;
    const gzip = this.currentGzip;
    const fileStream = this.currentFileStream;
    this.pendingCloses.push(
      new Promise<void>((resolve, reject) => {
        fileStream.on("finish", resolve);
        fileStream.on("error", reject);
        gzip.end();
      }),
    );
    this.currentGzip = undefined;
    this.currentFileStream = undefined;
  }
}
