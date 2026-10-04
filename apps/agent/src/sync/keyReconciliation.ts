/**
 * `deleteMode: "reconciliation"` (docs/plans/planometry-v4-migration.md
 * §1.2, slice D1 + its follow-up): a saved list of every key the agent has
 * sent (and not yet deleted), kept as wire-formatted key-only rows, so a
 * delta run can compute `saved - currentScan` and push those keys as
 * `mode: "delete"`.
 *
 * Bucket count: 256. Comparison is done one bucket at a time so at most
 * one bucket's worth of keys is ever held in memory — for 10,000,000
 * total keys that is ~39,063 keys/bucket on average; a JS `Set<string>`
 * holding that many short canonical-key strings (~150 bytes/entry
 * overhead+string) is roughly (2 sets live at once: current-scan bucket +
 * saved bucket) 2 * 39,063 * 150 bytes ~= 12 MB peak, independent of how
 * large the table grows beyond that (bucket count is fixed; only the
 * average bucket size grows).
 *
 * Storage layout: each job has one `jobDir` containing a small
 * `pointer.json` (`{ current: "<generation name>" }`) plus one or more
 * `gen-*` generation directories (each self-contained: `meta.json` +
 * per-bucket files). Committing a new list renames a staging dir into a
 * brand-new `gen-*` path (never over an existing/non-empty directory —
 * that rename fails on Windows and some Linux filesystems), then swaps
 * `pointer.json` with a single write-to-temp-then-rename, then removes
 * the now-orphaned previous generation. Every bucket file is a sequence
 * of length-prefixed AES-256-GCM frames, one per key, appended as they're
 * discovered — `KeyListWriter` never buffers more than one key/frame in
 * memory, and computed deletes live on disk (the deletes-staging
 * generation) from the moment each is found, never in an in-memory array.
 *
 * No key value is ever written in plaintext to disk: every bucket file
 * is AES-256-GCM encrypted via spoolCrypto.ts's envelope, and `meta.json`/
 * `pointer.json` (the only plaintext files) hold only `{ fingerprint,
 * bucketCount, totalKeys }` / `{ current: "<generation name>" }` — never
 * a key value.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { decryptSpoolBuffer, encryptSpoolBuffer } from "./spoolCrypto.js";
import { readReplaceSpool } from "./replaceSpool.js";
import type { WireRow } from "../planometry/formatForTarget.js";

export const KEY_BUCKET_COUNT = 256;

/** Stable regardless of the row's own property insertion order — `JSON.parse` of the result is a plain object directly usable as a `WireRow`. */
export function canonicalKeyString(keyRow: WireRow): string {
  return JSON.stringify(keyRow, Object.keys(keyRow).sort());
}

/** First 4 bytes of sha256(canonical) as a uint32, mod bucketCount. */
export function bucketIndexFor(canonicalKey: string, bucketCount: number = KEY_BUCKET_COUNT): number {
  const digest = createHash("sha256").update(canonicalKey, "utf8").digest();
  return digest.readUInt32BE(0) % bucketCount;
}

// --- paths -------------------------------------------------------------

/** Mirrors ops/state.ts's private encodeJobId (not exported there). */
function encodeJobId(jobId: string): string {
  return Buffer.from(jobId, "utf8").toString("base64url");
}

function keyReconciliationRootDir(dir: string): string {
  return path.join(dir, "key-reconciliation");
}

function jobDir(dir: string, jobId: string): string {
  return path.join(keyReconciliationRootDir(dir), encodeJobId(jobId));
}

function pointerFilePath(jobDirPath: string): string {
  return path.join(jobDirPath, "pointer.json");
}

function generationDir(jobDirPath: string, genName: string): string {
  return path.join(jobDirPath, genName);
}

function metaFilePath(genDirPath: string): string {
  return path.join(genDirPath, "meta.json");
}

function bucketFileName(bucketIndex: number): string {
  return `bucket-${String(bucketIndex).padStart(3, "0")}.ndjson.enc`;
}

function bucketFilePath(genDirPath: string, bucketIndex: number): string {
  return path.join(genDirPath, bucketFileName(bucketIndex));
}

/** `undefined` if no pointer file exists yet, or it's unreadable/malformed. */
async function readPointer(jobDirPath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(pointerFilePath(jobDirPath), "utf8");
    const parsed = JSON.parse(raw) as { current?: unknown };
    return typeof parsed.current === "string" ? parsed.current : undefined;
  } catch {
    return undefined;
  }
}

/** The single atomic step that switches readers to a new generation: write to a temp file, then `rename()` over `pointer.json`. */
async function writePointerAtomic(jobDirPath: string, genName: string): Promise<void> {
  await mkdir(jobDirPath, { recursive: true, mode: 0o700 });
  const tmp = path.join(jobDirPath, `.pointer-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  await fs.promises.writeFile(tmp, JSON.stringify({ current: genName }), { mode: 0o600 });
  await rename(tmp, pointerFilePath(jobDirPath));
}

/**
 * Removes every directory under the job's key-list dir that isn't the
 * live generation — leftover `.staging-*` dirs from an interrupted prior
 * run, and orphaned old `gen-*` dirs (e.g. if a process died between
 * renaming a new generation into place and removing the old one). Safe
 * to call when the job has no key-list dir at all yet. Call this at the
 * start of any run that touches reconciliation, before reading or
 * writing anything else under this job's key-list dir.
 */
export async function sweepStaleKeyListGenerations(dir: string, jobId: string): Promise<void> {
  const jobDirPath = jobDir(dir, jobId);
  let entries: string[];
  try {
    entries = await readdir(jobDirPath);
  } catch {
    return;
  }
  const current = await readPointer(jobDirPath);
  for (const entry of entries) {
    if (entry === "pointer.json" || entry === current) continue;
    await rm(path.join(jobDirPath, entry), { recursive: true, force: true });
  }
}

// --- saved list read/remove ---------------------------------------------

/** `meta.json` holds only `{ fingerprint, bucketCount, totalKeys }` — never a key value. */
export interface KeyListMeta {
  fingerprint: string;
  bucketCount: number;
  totalKeys: number;
}

export async function readSavedKeyListMeta(dir: string, jobId: string): Promise<KeyListMeta | undefined> {
  const jobDirPath = jobDir(dir, jobId);
  const current = await readPointer(jobDirPath);
  if (!current) return undefined;
  try {
    const raw = await readFile(metaFilePath(generationDir(jobDirPath, current)), "utf8");
    return JSON.parse(raw) as KeyListMeta;
  } catch {
    return undefined;
  }
}

/** Decodes every length-prefixed `[4-byte BE length][AES-GCM envelope]` frame in one bucket file. Empty array if the file is absent. */
async function readFramesFromFile(filePath: string, masterKey: Buffer): Promise<string[]> {
  let raw: Buffer;
  try {
    raw = await readFile(filePath);
  } catch {
    return [];
  }
  const keys: string[] = [];
  let offset = 0;
  while (offset + 4 <= raw.length) {
    const len = raw.readUInt32BE(offset);
    offset += 4;
    const envelope = raw.subarray(offset, offset + len);
    offset += len;
    keys.push(decryptSpoolBuffer(masterKey, envelope).toString("utf8"));
  }
  return keys;
}

/** Decrypts+parses one bucket's saved keys from the live generation. Empty Set if there's no saved list, or the bucket had no keys. */
export async function readSavedBucketKeys(dir: string, jobId: string, bucketIndex: number, masterKey: Buffer): Promise<Set<string>> {
  const jobDirPath = jobDir(dir, jobId);
  const current = await readPointer(jobDirPath);
  if (!current) return new Set();
  const keys = await readFramesFromFile(bucketFilePath(generationDir(jobDirPath, current), bucketIndex), masterKey);
  return new Set(keys);
}

/** `job remove` cleanup — removes the saved key list entirely (pointer + every generation). Safe to call when nothing was ever saved. */
export async function removeKeyList(dir: string, jobId: string): Promise<void> {
  await rm(jobDir(dir, jobId), { recursive: true, force: true });
}

// --- bucket-indexed streaming writer (shared by "new saved list" and "computed deletes") ---

function writeToStream(stream: fs.WriteStream, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}

function closeStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
}

class KeyListWriter {
  private readonly stagingDir: string;
  private readonly streams = new Map<number, fs.WriteStream>();
  private closed = false;
  private meta: KeyListMeta | undefined;

  constructor(
    private readonly jobDirPath: string,
    private readonly masterKey: Buffer,
    label: string,
  ) {
    this.stagingDir = path.join(jobDirPath, `.staging-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  async prepare(): Promise<void> {
    await mkdir(this.stagingDir, { recursive: true, mode: 0o700 });
  }

  private getStream(bucketIndex: number): fs.WriteStream {
    let stream = this.streams.get(bucketIndex);
    if (!stream) {
      stream = fs.createWriteStream(bucketFilePath(this.stagingDir, bucketIndex), { mode: 0o600 });
      this.streams.set(bucketIndex, stream);
    }
    return stream;
  }

  /** Encrypts one key and appends it as a length-prefixed frame to its bucket's file — never buffers more than one key/frame in memory. */
  async appendKey(bucketIndex: number, canonicalKey: string): Promise<void> {
    const envelope = encryptSpoolBuffer(this.masterKey, Buffer.from(canonicalKey, "utf8"));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(envelope.length, 0);
    await writeToStream(this.getStream(bucketIndex), Buffer.concat([header, envelope]));
  }

  writeMeta(meta: KeyListMeta): void {
    this.meta = meta;
  }

  async closeStreams(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const streams = [...this.streams.values()];
    this.streams.clear();
    await Promise.all(streams.map((s) => closeStream(s)));
  }

  /** Streams this (not-yet-committed) staging dir's frames back out as WireRows. Closes streams first so every appended frame is flushed to disk. */
  async *readRows(): AsyncGenerator<WireRow> {
    await this.closeStreams();
    yield* readBucketStagingRows(this.stagingDir, this.masterKey);
  }

  /**
   * Commits this staging dir as a brand-new generation and atomically
   * swaps the job's pointer file to it. Never renames a directory over
   * an existing/non-empty one (that fails on Windows and some Linux
   * filesystems): the staging dir is renamed to a fresh, never-before-
   * used `gen-*` path, `pointer.json` is then swapped with a single
   * write-to-temp-then-rename, and only afterward is the now-orphaned
   * previous generation (if any) removed.
   */
  async commitTo(jobDirPath: string): Promise<void> {
    await this.closeStreams();
    if (this.meta) {
      await fs.promises.writeFile(metaFilePath(this.stagingDir), JSON.stringify(this.meta, null, 2), { mode: 0o600 });
    }
    await mkdir(jobDirPath, { recursive: true, mode: 0o700 });
    const genName = `gen-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await rename(this.stagingDir, generationDir(jobDirPath, genName));
    const previousGen = await readPointer(jobDirPath);
    await writePointerAtomic(jobDirPath, genName);
    if (previousGen && previousGen !== genName) {
      await rm(generationDir(jobDirPath, previousGen), { recursive: true, force: true });
    }
  }

  /** Discards this staging dir without touching anything already committed. */
  async discard(): Promise<void> {
    await this.closeStreams();
    await rm(this.stagingDir, { recursive: true, force: true });
  }
}

async function* readBucketStagingRows(stagingDir: string, masterKey: Buffer): AsyncGenerator<WireRow> {
  let names: string[];
  try {
    names = await readdir(stagingDir);
  } catch {
    return;
  }
  for (const name of names.filter((n) => n.startsWith("bucket-") && n.endsWith(".ndjson.enc")).sort()) {
    const keys = await readFramesFromFile(path.join(stagingDir, name), masterKey);
    for (const key of keys) yield JSON.parse(key) as WireRow;
  }
}

// --- replace-mode: rebuild the saved list directly from a just-written replace spool ---

/**
 * For a replace-mode run: no scan, no deletes (the whole table was just
 * replaced, nothing stale to remove) — the new saved list is simply every
 * key in the rows just sent. Does NOT commit — returns the built list's
 * stats plus `commit`/`discard` closures so the caller can defer
 * committing until after everything else in the run has succeeded.
 */
export async function buildReplaceKeyList(
  dir: string,
  jobId: string,
  masterKey: Buffer,
  fingerprint: string,
  spoolDir: string,
  runId: string,
  keyTargets: string[],
  bucketCount: number = KEY_BUCKET_COUNT,
): Promise<{ totalKeys: number; duplicateKeyCount: number; commit: () => Promise<void>; discard: () => Promise<void> }> {
  const jobDirPath = jobDir(dir, jobId);
  const writer = new KeyListWriter(jobDirPath, masterKey, "replace");
  await writer.prepare();

  let totalKeys = 0;
  let duplicateKeyCount = 0;
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const bucketKeys = new Set<string>();
    for await (const row of readReplaceSpool(spoolDir, runId, masterKey)) {
      const keyRow = pickKeyRow(row, keyTargets);
      const canonical = canonicalKeyString(keyRow);
      if (bucketIndexFor(canonical, bucketCount) !== bucket) continue;
      if (bucketKeys.has(canonical)) {
        duplicateKeyCount += 1;
      } else {
        bucketKeys.add(canonical);
      }
    }
    totalKeys += bucketKeys.size;
    for (const key of bucketKeys) await writer.appendKey(bucket, key);
  }

  writer.writeMeta({ fingerprint, bucketCount, totalKeys });
  return {
    totalKeys,
    duplicateKeyCount,
    commit: () => writer.commitTo(jobDirPath),
    discard: () => writer.discard(),
  };
}

function pickKeyRow(row: WireRow, keyTargets: string[]): WireRow {
  const picked: WireRow = {};
  for (const target of keyTargets) picked[target] = row[target] ?? null;
  return picked;
}

// --- mass-delete guard ---------------------------------------------------

export interface MassDeleteGuardResult {
  tripped: boolean;
  reason?: string;
}

export function evaluateMassDeleteGuard(
  stats: { currentTotal: number; savedTotal: number; deleteCount: number },
  maxDeletePercent: number,
  allowMassDelete: boolean,
): MassDeleteGuardResult {
  if (allowMassDelete) return { tripped: false };
  if (stats.currentTotal === 0) {
    return {
      tripped: true,
      reason: `key reconciliation saw zero keys in the current scan — refusing to delete the entire saved list of ${stats.savedTotal} key(s). Re-run with --allow-mass-delete if this is expected.`,
    };
  }
  if (stats.savedTotal > 0) {
    const percent = (stats.deleteCount / stats.savedTotal) * 100;
    if (percent > maxDeletePercent) {
      return {
        tripped: true,
        reason: `key reconciliation would delete ${stats.deleteCount} of ${stats.savedTotal} saved key(s) (${percent.toFixed(1)}%), above the ${maxDeletePercent}% limit. Re-run with --allow-mass-delete to proceed anyway.`,
      };
    }
  }
  return { tripped: false };
}

// --- upsert-mode delta run: full scan + diff + guard ---------------------

export interface ComputeReconciliationInput {
  dir: string;
  jobId: string;
  masterKey: Buffer;
  fingerprint: string;
  bucketCount?: number;
  /** Where this run's key-only scan rows were spooled (sync/replaceSpool.ts reused as-is). */
  scanSpoolDir: string;
  scanRunId: string;
  /** Canonical key strings for every row upserted by this same run. */
  upsertedKeysThisRun: Set<string>;
  maxDeletePercent: number;
  allowMassDelete: boolean;
}

export interface ReconciliationStats {
  currentTotal: number;
  savedTotal: number;
  deleteCount: number;
  duplicateKeyCount: number;
}

export interface ReconciliationOutcome {
  guard: MassDeleteGuardResult;
  stats: ReconciliationStats;
  /** Streams this run's computed deletes as WireRows (key columns only). Only meaningful when `guard.tripped` is false. */
  readDeletes: () => AsyncGenerator<WireRow>;
  /** Atomically replaces the live saved list with the new one and discards the deletes-staging dir. Call only after both the upsert push and the delete push have succeeded. */
  commit: () => Promise<void>;
  /** Discards both staging dirs without touching the live saved list. Call on any failure (guard tripped, delete push failed, etc). */
  discard: () => Promise<void>;
}

export async function computeReconciliation(input: ComputeReconciliationInput): Promise<ReconciliationOutcome> {
  const bucketCount = input.bucketCount ?? KEY_BUCKET_COUNT;
  const jobDirPath = jobDir(input.dir, input.jobId);

  const savedMeta = await readSavedKeyListMeta(input.dir, input.jobId);
  const fingerprintMatches = savedMeta !== undefined && savedMeta.fingerprint === input.fingerprint;
  const savedTotal = fingerprintMatches ? savedMeta!.totalKeys : 0;

  const newListWriter = new KeyListWriter(jobDirPath, input.masterKey, "newlist");
  const deletesWriter = new KeyListWriter(jobDirPath, input.masterKey, "deletes");
  await newListWriter.prepare();
  await deletesWriter.prepare();

  // Pre-bucket the keys upserted by this run (this run's row count only — small, never the whole saved list).
  const upsertedByBucket = new Map<number, Set<string>>();
  for (const canonical of input.upsertedKeysThisRun) {
    const bucket = bucketIndexFor(canonical, bucketCount);
    let set = upsertedByBucket.get(bucket);
    if (!set) {
      set = new Set<string>();
      upsertedByBucket.set(bucket, set);
    }
    set.add(canonical);
  }

  let currentTotal = 0;
  let deleteCount = 0;
  let duplicateKeyCount = 0;

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const currentKeys = new Set<string>();
    // Duplicate counting covers only repeats within the scan itself — a key
    // that also appears in this run's upserts (merged in below) is never
    // counted as a duplicate.
    for await (const row of readReplaceSpool(input.scanSpoolDir, input.scanRunId, input.masterKey)) {
      const canonical = canonicalKeyString(row);
      if (bucketIndexFor(canonical, bucketCount) !== bucket) continue;
      if (currentKeys.has(canonical)) {
        duplicateKeyCount += 1;
      } else {
        currentKeys.add(canonical);
      }
    }
    for (const canonical of upsertedByBucket.get(bucket) ?? []) {
      currentKeys.add(canonical);
    }
    currentTotal += currentKeys.size;

    const savedKeys = fingerprintMatches ? await readSavedBucketKeys(input.dir, input.jobId, bucket, input.masterKey) : new Set<string>();
    for (const saved of savedKeys) {
      if (!currentKeys.has(saved)) {
        deleteCount += 1;
        await deletesWriter.appendKey(bucket, saved);
      }
    }

    for (const key of currentKeys) {
      await newListWriter.appendKey(bucket, key);
    }
  }
  await deletesWriter.closeStreams();

  const stats: ReconciliationStats = { currentTotal, savedTotal, deleteCount, duplicateKeyCount };
  const guard = evaluateMassDeleteGuard(stats, input.maxDeletePercent, input.allowMassDelete);

  newListWriter.writeMeta({ fingerprint: input.fingerprint, bucketCount, totalKeys: currentTotal });

  return {
    guard,
    stats,
    readDeletes: () => deletesWriter.readRows(),
    commit: async () => {
      await newListWriter.commitTo(jobDirPath);
      await deletesWriter.discard();
    },
    discard: async () => {
      await newListWriter.discard();
      await deletesWriter.discard();
    },
  };
}
