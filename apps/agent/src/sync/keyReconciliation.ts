/**
 * `deleteMode: "reconciliation"` (docs/plans/planometry-v4-migration.md
 * §1.2, slice D1): a saved list of every key the agent has sent (and not
 * yet deleted), kept as wire-formatted key-only rows, so a delta run can
 * compute `saved - currentScan` and push those keys as `mode: "delete"`.
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
 * This bound is achieved by re-using the existing `ReplaceSpoolWriter`/
 * `readReplaceSpool` pair (sync/replaceSpool.ts) to hold the current
 * scan's key rows on disk, then re-reading that same spooled file once
 * per bucket (256 full re-reads), keeping only that bucket's keys in
 * memory each pass. This trades I/O passes for simplicity and bounded
 * memory, reusing an already-proven mechanism rather than a new
 * per-bucket fan-out writer (which would risk a filesystem blow-up at
 * scale — up to hundreds of thousands of tiny files). At the scale this
 * slice is tested/run at (tens to a few thousand rows), 256 re-reads of a
 * small file cost nothing in practice.
 *
 * No key value is ever written in plaintext to disk: every bucket file
 * is AES-256-GCM encrypted via spoolCrypto.ts's envelope, and `meta.json`
 * (the only plaintext file) holds only `{ fingerprint, bucketCount,
 * totalKeys }` — never a key value.
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

function keyListDir(dir: string, jobId: string): string {
  return path.join(keyReconciliationRootDir(dir), encodeJobId(jobId));
}

function metaFilePath(listDir: string): string {
  return path.join(listDir, "meta.json");
}

function bucketFileName(bucketIndex: number): string {
  return `bucket-${String(bucketIndex).padStart(3, "0")}.ndjson.enc`;
}

function bucketFilePath(listDir: string, bucketIndex: number): string {
  return path.join(listDir, bucketFileName(bucketIndex));
}

// --- saved list read/remove ---------------------------------------------

/** `meta.json` holds only `{ fingerprint, bucketCount, totalKeys }` — never a key value. */
export interface KeyListMeta {
  fingerprint: string;
  bucketCount: number;
  totalKeys: number;
}

export async function readSavedKeyListMeta(dir: string, jobId: string): Promise<KeyListMeta | undefined> {
  try {
    const raw = await readFile(metaFilePath(keyListDir(dir, jobId)), "utf8");
    return JSON.parse(raw) as KeyListMeta;
  } catch {
    return undefined;
  }
}

/** Decrypts+parses one bucket's saved keys. Empty Set if the file is absent (bucket had no keys, or the list itself doesn't exist). */
export async function readSavedBucketKeys(dir: string, jobId: string, bucketIndex: number, masterKey: Buffer): Promise<Set<string>> {
  const keys = new Set<string>();
  let raw: Buffer;
  try {
    raw = await readFile(bucketFilePath(keyListDir(dir, jobId), bucketIndex));
  } catch {
    return keys;
  }
  const plaintext = decryptSpoolBuffer(masterKey, raw).toString("utf8");
  for (const line of plaintext.split("\n")) {
    if (line.length === 0) continue;
    keys.add(line);
  }
  return keys;
}

/** `job remove` cleanup — removes the saved key list entirely. Safe to call when nothing was ever saved. */
export async function removeKeyList(dir: string, jobId: string): Promise<void> {
  await rm(keyListDir(dir, jobId), { recursive: true, force: true });
}

// --- bucket-indexed staging writer (shared by "new saved list" and "computed deletes") ---

class BucketStagingWriter {
  private readonly stagingDir: string;
  private meta: KeyListMeta | undefined;

  constructor(
    private readonly rootDir: string,
    private readonly masterKey: Buffer,
    label: string,
  ) {
    this.stagingDir = path.join(rootDir, `.staging-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  async prepare(): Promise<void> {
    await mkdir(this.stagingDir, { recursive: true, mode: 0o700 });
  }

  /** Encrypts+writes one bucket's canonical keys in one shot (a single bucket's content is bounded — see module doc's memory math). Skips writing a file at all for an empty bucket. */
  async writeBucket(bucketIndex: number, canonicalKeys: Iterable<string>): Promise<void> {
    const lines: string[] = [];
    for (const key of canonicalKeys) lines.push(key);
    if (lines.length === 0) return;
    const plaintext = Buffer.from(lines.join("\n") + "\n", "utf8");
    const envelope = encryptSpoolBuffer(this.masterKey, plaintext);
    await fs.promises.writeFile(bucketFilePath(this.stagingDir, bucketIndex), envelope, { mode: 0o600 });
  }

  writeMeta(meta: KeyListMeta): void {
    this.meta = meta;
  }

  /** Streams every bucket file in this (not-yet-committed) staging dir back out as WireRows — used by the deletes-staging writer's `readDeletes()`. */
  async *readRows(): AsyncGenerator<WireRow> {
    yield* readBucketStagingRows(this.stagingDir, this.masterKey);
  }

  /**
   * Atomically swaps this staging dir into place as `liveDir`. Moves any
   * pre-existing live dir aside first, renames staging into place, then
   * removes the old sibling only once the swap itself has succeeded — the
   * live path is never observably missing, and a rename failure rolls the
   * old dir back before rethrowing.
   */
  async commitTo(liveDir: string): Promise<void> {
    if (this.meta) {
      await fs.promises.writeFile(metaFilePath(this.stagingDir), JSON.stringify(this.meta, null, 2), { mode: 0o600 });
    }
    const oldAside = `${liveDir}.old-${process.pid}-${Date.now()}`;
    let hadOld = false;
    try {
      await rename(liveDir, oldAside);
      hadOld = true;
    } catch {
      hadOld = false;
    }
    try {
      await rename(this.stagingDir, liveDir);
    } catch (err) {
      if (hadOld) {
        await rename(oldAside, liveDir).catch(() => {});
      }
      throw err;
    }
    if (hadOld) {
      await rm(oldAside, { recursive: true, force: true });
    }
  }

  /** Discards this staging dir without touching anything already committed. */
  async discard(): Promise<void> {
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
    const raw = await readFile(path.join(stagingDir, name));
    const plaintext = decryptSpoolBuffer(masterKey, raw).toString("utf8");
    for (const line of plaintext.split("\n")) {
      if (line.length === 0) continue;
      yield JSON.parse(line) as WireRow;
    }
  }
}

// --- replace-mode: rebuild the saved list directly from a just-written replace spool ---

/** For a replace-mode run: no scan, no deletes (the whole table was just replaced, nothing stale to remove) — the new saved list is simply every key in the rows just sent. */
export async function buildKeyListFromReplace(
  dir: string,
  jobId: string,
  masterKey: Buffer,
  fingerprint: string,
  spoolDir: string,
  runId: string,
  keyTargets: string[],
  bucketCount: number = KEY_BUCKET_COUNT,
): Promise<{ totalKeys: number; duplicateKeyCount: number }> {
  const root = keyReconciliationRootDir(dir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const writer = new BucketStagingWriter(root, masterKey, "replace");
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
    await writer.writeBucket(bucket, bucketKeys);
  }

  writer.writeMeta({ fingerprint, bucketCount, totalKeys });
  await writer.commitTo(keyListDir(dir, jobId));
  return { totalKeys, duplicateKeyCount };
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
  const root = keyReconciliationRootDir(input.dir);
  await mkdir(root, { recursive: true, mode: 0o700 });

  const savedMeta = await readSavedKeyListMeta(input.dir, input.jobId);
  const fingerprintMatches = savedMeta !== undefined && savedMeta.fingerprint === input.fingerprint;
  const savedTotal = fingerprintMatches ? savedMeta!.totalKeys : 0;

  const newListWriter = new BucketStagingWriter(root, input.masterKey, "newlist");
  const deletesWriter = new BucketStagingWriter(root, input.masterKey, "deletes");
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
    const deletesInBucket: string[] = [];
    for (const saved of savedKeys) {
      if (!currentKeys.has(saved)) deletesInBucket.push(saved);
    }
    deleteCount += deletesInBucket.length;

    await newListWriter.writeBucket(bucket, currentKeys);
    await deletesWriter.writeBucket(bucket, deletesInBucket);
  }

  const stats: ReconciliationStats = { currentTotal, savedTotal, deleteCount, duplicateKeyCount };
  const guard = evaluateMassDeleteGuard(stats, input.maxDeletePercent, input.allowMassDelete);

  newListWriter.writeMeta({ fingerprint: input.fingerprint, bucketCount, totalKeys: currentTotal });

  return {
    guard,
    stats,
    readDeletes: () => deletesWriter.readRows(),
    commit: async () => {
      await newListWriter.commitTo(keyListDir(input.dir, input.jobId));
      await deletesWriter.discard();
    },
    discard: async () => {
      await newListWriter.discard();
      await deletesWriter.discard();
    },
  };
}

