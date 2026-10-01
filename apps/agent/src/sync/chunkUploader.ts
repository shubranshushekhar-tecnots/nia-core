import { readFile } from "node:fs/promises";
import { ChunkRejectedError, type PlanometryClient } from "../planometry/client.js";
import type { HeartbeatScheduler } from "../planometry/heartbeatScheduler.js";
import { decryptSpoolBuffer } from "./spoolCrypto.js";
import type { SpoolChunkFile } from "./spoolWriter.js";

export interface ChunkUploaderOptions {
  /** Attempts per chunk before giving up (not counting the 409 case, which never retries). */
  maxAttempts?: number;
  baseDelayMs?: number;
  /** Checked before each chunk; an already-aborted signal stops the upload (throws), reported as a failed run by the caller. */
  signal?: AbortSignal;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 500;

/**
 * Uploads spooled chunk files to Planometry in seq order (Phase 2 §4:
 * "uploads from disk with X-Chunk-Seq, retries/backoff never touching
 * DB"). A transport/5xx failure retries the *same* seq with exponential
 * backoff + jitter, up to `maxAttempts`. A 409 (`ChunkRejectedError`,
 * "run superseded") is never retried — it propagates immediately so the
 * caller can abort the run and clean up the spool.
 *
 * Each file is decrypted (spoolCrypto.ts) right after reading it off disk,
 * before the gzip bytes ever leave this process — a truncated/tampered
 * spool file fails the authTag check here and aborts the run instead of
 * silently uploading garbage.
 */
export async function uploadChunks(client: PlanometryClient, runId: string, files: SpoolChunkFile[], masterKey: Buffer, heartbeat: HeartbeatScheduler, options: ChunkUploaderOptions = {}): Promise<void> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  for (const file of files) {
    if (options.signal?.aborted) throw new Error("aborted");
    const raw = await readFile(file.path);
    const body = decryptSpoolBuffer(masterKey, raw);
    await uploadWithRetry(client, runId, file.seq, file.rows, body, maxAttempts, baseDelayMs);
    heartbeat.markActivity();
  }
}

async function uploadWithRetry(client: PlanometryClient, runId: string, seq: number, rows: number, body: Buffer, maxAttempts: number, baseDelayMs: number): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await client.pushChunk(runId, seq, rows, body);
      return;
    } catch (err) {
      if (err instanceof ChunkRejectedError) throw err;
      if (attempt === maxAttempts) throw err;
      await sleep(backoffDelayMs(attempt, baseDelayMs));
    }
  }
}

function backoffDelayMs(attempt: number, baseDelayMs: number): number {
  const exp = baseDelayMs * 2 ** (attempt - 1);
  const jitter = Math.random() * baseDelayMs;
  return exp + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
