import { createWriteStream } from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { decryptSpoolBuffer, encryptSpoolBuffer } from "./spoolCrypto.js";
import type { WireRow } from "../planometry/formatForTarget.js";

/**
 * Encrypted on-disk spool for a replace load's already-mapped,
 * already-formatted `WireRow`s (docs/plans/planometry-v4-migration.md §10
 * slice A4, run order step (c)). Rows are written once, during extraction,
 * then re-read from disk one or more times by sync/replaceLoad.ts: once to
 * peek whether the load is single- or multi-part, and again (freshly, from
 * the top) to actually build and send request parts — `readReplaceSpool`
 * is a fresh async generator on every call, not a one-shot consumer.
 *
 * Reuses the shared spoolDir + runId-prefixed-filename convention
 * (config/paths.ts's defaultSpoolDir) and spoolCrypto.ts's AES-256-GCM
 * envelope, but (unlike sync/spoolWriter.ts) has no columns-header/
 * trailer protocol to replicate — every line is just one formatted
 * `WireRow`'s JSON, since the shape going to Planometry is already final
 * by the time a row reaches this spool.
 */
export interface ReplaceSpoolOptions {
  /** Row threshold per chunk file. */
  maxRows?: number;
  /** Uncompressed-byte threshold per chunk file, measured pre-gzip. */
  maxBytes?: number;
}

const DEFAULT_MAX_ROWS = 50_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

function spoolFileName(runId: string, seq: number): string {
  return `${runId}.replace.${String(seq).padStart(5, "0")}.ndjson.gz`;
}

export class ReplaceSpoolWriter {
  private readonly maxRows: number;
  private readonly maxBytes: number;
  private seq = 0;
  private currentRows = 0;
  private currentBytes = 0;
  private currentLines: string[] = [];
  private readonly pendingCloses: Promise<void>[] = [];
  private drainListener: (() => void) | undefined;

  constructor(
    private readonly dir: string,
    private readonly runId: string,
    private readonly masterKey: Buffer,
    options: ReplaceSpoolOptions = {},
  ) {
    this.maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async prepare(): Promise<void> {
    // Owner-only (0o700): holds raw (already-formatted) customer row data.
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  /** Writes one row to the spool, rotating to a new chunk file once the row/byte threshold is crossed. Returns `false` to signal backpressure (mirrors Writable.write()'s contract), always `true` here since writes are buffered/flushed synchronously per chunk. */
  write(row: WireRow): boolean {
    const line = JSON.stringify(row);
    this.currentLines.push(line);
    this.currentRows += 1;
    this.currentBytes += Buffer.byteLength(line, "utf8") + 1;
    if (this.currentRows >= this.maxRows || this.currentBytes >= this.maxBytes) {
      this.flushCurrent();
    }
    return true;
  }

  /** No real backpressure source here (writes are synchronous/buffered) — kept for interface symmetry with SpoolWriter/NdjsonWriter callers. */
  onDrain(listener: () => void): void {
    this.drainListener = listener;
  }

  /** Flushes any remaining buffered rows and waits for every chunk file to finish writing to disk. */
  async finish(): Promise<void> {
    this.flushCurrent();
    await Promise.all(this.pendingCloses);
    this.drainListener?.();
  }

  private flushCurrent(): void {
    if (this.currentLines.length === 0) return;
    const seq = this.seq;
    this.seq += 1;
    const filePath = path.join(this.dir, spoolFileName(this.runId, seq));
    const plaintext = Buffer.from(this.currentLines.join("\n") + "\n", "utf8");
    const gzipped = zlib.gzipSync(plaintext);
    const envelope = encryptSpoolBuffer(this.masterKey, gzipped);
    this.currentLines = [];
    this.currentRows = 0;
    this.currentBytes = 0;

    this.pendingCloses.push(
      new Promise<void>((resolve, reject) => {
        // Owner-only (0o600): encrypted, but still defense in depth.
        const fileStream = createWriteStream(filePath, { mode: 0o600 });
        fileStream.on("finish", resolve);
        fileStream.on("error", reject);
        fileStream.end(envelope);
      }),
    );
  }
}

function listSpoolFiles(dir: string, runId: string): string[] {
  const prefix = `${runId}.replace.`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(prefix) && name.endsWith(".ndjson.gz"))
    .sort();
}

/** Re-reads every row previously written for `runId`, in chunk-file order. A fresh generator each call — safe to iterate more than once (replaceLoad.ts peeks, then reads again from the top). */
export async function* readReplaceSpool(dir: string, runId: string, masterKey: Buffer): AsyncGenerator<WireRow> {
  for (const name of listSpoolFiles(dir, runId)) {
    const raw = readFileSync(path.join(dir, name));
    const gzipped = decryptSpoolBuffer(masterKey, raw);
    const plaintext = zlib.gunzipSync(gzipped).toString("utf8");
    for (const line of plaintext.split("\n")) {
      if (line.length === 0) continue;
      yield JSON.parse(line) as WireRow;
    }
  }
}

/** Best-effort cleanup, used even if the writer instance itself isn't available (e.g. runSync.ts's shared cleanup path). Safe to call when nothing was ever written. */
export async function removeReplaceSpool(dir: string, runId: string): Promise<void> {
  for (const name of listSpoolFiles(dir, runId)) {
    await rm(path.join(dir, name), { force: true });
  }
}
