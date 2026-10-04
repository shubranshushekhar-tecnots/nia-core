import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SyncJobEntry } from "../config/types.js";
import { Logger } from "../ops/logger.js";
import { isJobPaused } from "../ops/state.js";
import { FakePlanometryServer, type FakeTableHandle } from "../testing/fakePlanometryServer.js";
import { KeyedSemaphore } from "./concurrency.js";
import { bucketIndexFor, canonicalKeyString, readSavedBucketKeys, readSavedKeyListMeta } from "./keyReconciliation.js";
import { runSync, type RunSyncOptions } from "./runSync.js";
import { computeJobFingerprint } from "./watermark.js";

/**
 * The 4 unit tests required by docs/plans/planometry-v4-migration.md §10
 * (D1): 1 Allowed, 1 Refused (two sub-cases), 1 Guard (no saved list /
 * fingerprint mismatch, two sub-cases), 1 Guard (no plaintext key values
 * on disk). Template = sync/upsertDelta.test.ts — same fake Planometry
 * HTTP server, no containers. Exercises `runSync` end to end with
 * `options.reconciliation` set, not `sync/keyReconciliation.ts`'s
 * internals directly (except the last test's raw on-disk byte check).
 */

const baseColumns = [
  { name: "id", type: "Number" as const, isKey: true },
  { name: "qty", type: "Number" as const, isKey: false },
];

function baseJob(handle: FakeTableHandle, overrides: Partial<SyncJobEntry> = {}): SyncJobEntry {
  return {
    id: "job-1",
    name: "test job",
    connectionId: "conn-1",
    sourceTable: "dbo.source",
    targetUrl: handle.tableUrl,
    pushKeyRef: "unused",
    strategy: "upsertDelta",
    deleteMode: "reconciliation",
    mapping: [
      { source: "id", target: "id" },
      { source: "qty", target: "qty" },
    ],
    targetSchemaSnapshot: {
      columns: baseColumns,
      keyColumns: ["id"],
    },
    onNullKey: "stop",
    allowEmptyReplace: false,
    filter: [],
    params: {},
    watermarkColumn: "modified_at",
    overlapSeconds: 300,
    ...overrides,
  };
}

function silentLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;
}

/** Same shape as both `readSourceRows` and `reconciliation.readKeyScanRows` — both are `(onRow, signal) => Promise<void>`. */
function source(rows: Record<string, unknown>[]) {
  return async (onRow: (row: Record<string, unknown>) => void, signal: AbortSignal) => {
    for (const row of rows) {
      if (signal.aborted) return;
      onRow(row);
    }
  };
}

function collectFiles(root: string): string[] {
  const out: string[] = [];
  function walk(d: string) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  }
  try {
    walk(root);
  } catch {
    // directory doesn't exist — nothing to collect.
  }
  return out;
}

describe("key reconciliation (sync/keyReconciliation.ts, sync/deletePush.ts, sync/runSync.ts)", () => {
  let dir: string;
  let server: FakePlanometryServer;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-agent-keyreconciliation-"));
    server = await FakePlanometryServer.start();
  });

  afterEach(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function baseOptions(job: SyncJobEntry, pushKey: string, overrides: Partial<RunSyncOptions> = {}): RunSyncOptions {
    return {
      job,
      pushKey,
      sourceColumnTypes: { id: "number", qty: "number", modified_at: "datetime" },
      dir,
      masterKey: Buffer.alloc(32),
      tableSemaphore: new KeyedSemaphore(1),
      logger: silentLogger(),
      readSourceRows: source([]),
      ...overrides,
    };
  }

  it("Allowed: a saved key missing from the current scan is sent as a delete after upserts, and the saved list is replaced only after both succeed", async () => {
    const handle = server.createTable({ columns: [...baseColumns, { name: "modified_at", type: "DateTime", isKey: false }] });
    const job = baseJob(handle);
    const fingerprint = computeJobFingerprint(job);

    // Seed: no saved watermark yet, so this is a replace — the saved key
    // list is built directly from the rows just replaced (keys 1 and 2).
    const seed = await runSync(
      baseOptions(job, handle.pushKey, {
        readSourceRows: source([
          { id: 1, qty: 10, modified_at: "2026-01-01T00:05:00.000" },
          { id: 2, qty: 20, modified_at: "2026-01-01T00:06:00.000" },
        ]),
        delta: {
          watermarkColumn: "modified_at",
          overlapSeconds: 300,
          savedWatermark: undefined,
          forceReplace: false,
          isParamOverride: false,
          serverClockAtStart: "2026-01-01T00:10:00.000",
          fingerprint,
        },
        reconciliation: { readKeyScanRows: source([]), maxDeletePercent: 100, allowMassDelete: false },
      }),
    );
    expect(seed.outcome).toBe("completed");
    expect(server.getRows(handle.tableId)).toHaveLength(2);
    const metaAfterSeed = await readSavedKeyListMeta(dir, job.id);
    expect(metaAfterSeed?.totalKeys).toBe(2);

    // Delta run: no upsert changes, but the current scan only sees key 2
    // — key 1 has disappeared from the source and should be deleted.
    const result = await runSync(
      baseOptions(job, handle.pushKey, {
        readSourceRows: source([]),
        delta: {
          watermarkColumn: "modified_at",
          overlapSeconds: 300,
          savedWatermark: "2026-01-01T00:06:00.000",
          forceReplace: false,
          isParamOverride: false,
          serverClockAtStart: "2026-01-01T00:20:00.000",
          fingerprint,
        },
        reconciliation: { readKeyScanRows: source([{ id: 2 }]), maxDeletePercent: 100, allowMassDelete: false },
      }),
    );

    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") return;
    expect(result.reconciliation).toEqual({ deletesSent: 1, duplicateKeyCount: 0 });

    // Row 1 removed, row 2 untouched.
    const rows = server.getRows(handle.tableId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("2");

    // The saved list on disk now replaces key 1 with only key 2.
    const metaAfterDelta = await readSavedKeyListMeta(dir, job.id);
    expect(metaAfterDelta?.totalKeys).toBe(1);

    const canonical2 = canonicalKeyString({ id: "2" });
    const savedKeys2 = await readSavedBucketKeys(dir, job.id, bucketIndexFor(canonical2), Buffer.alloc(32));
    expect(savedKeys2.has(canonical2)).toBe(true);

    const canonical1 = canonicalKeyString({ id: "1" });
    const savedKeys1 = await readSavedBucketKeys(dir, job.id, bucketIndexFor(canonical1), Buffer.alloc(32));
    expect(savedKeys1.has(canonical1)).toBe(false);
  });

  it("Refused: deletes above maxDeletePercent, and a zero-key current scan, both send no delete and pause the job", async () => {
    // Sub-case A: computed deletes (3 of 4 saved keys = 75%) exceed the 50% limit.
    const handleA = server.createTable({ columns: [...baseColumns, { name: "modified_at", type: "DateTime", isKey: false }] });
    const jobA = baseJob(handleA, { id: "job-a" });
    const fingerprintA = computeJobFingerprint(jobA);

    const seedA = await runSync(
      baseOptions(jobA, handleA.pushKey, {
        readSourceRows: source([
          { id: 1, qty: 10, modified_at: "2026-01-01T00:05:00.000" },
          { id: 2, qty: 20, modified_at: "2026-01-01T00:05:00.000" },
          { id: 3, qty: 30, modified_at: "2026-01-01T00:05:00.000" },
          { id: 4, qty: 40, modified_at: "2026-01-01T00:05:00.000" },
        ]),
        delta: {
          watermarkColumn: "modified_at",
          overlapSeconds: 300,
          savedWatermark: undefined,
          forceReplace: false,
          isParamOverride: false,
          serverClockAtStart: "2026-01-01T00:10:00.000",
          fingerprint: fingerprintA,
        },
        reconciliation: { readKeyScanRows: source([]), maxDeletePercent: 100, allowMassDelete: false },
      }),
    );
    expect(seedA.outcome).toBe("completed");

    const resultA = await runSync(
      baseOptions(jobA, handleA.pushKey, {
        readSourceRows: source([]),
        delta: {
          watermarkColumn: "modified_at",
          overlapSeconds: 300,
          savedWatermark: "2026-01-01T00:06:00.000",
          forceReplace: false,
          isParamOverride: false,
          serverClockAtStart: "2026-01-01T00:20:00.000",
          fingerprint: fingerprintA,
        },
        reconciliation: { readKeyScanRows: source([{ id: 1 }]), maxDeletePercent: 50, allowMassDelete: false },
      }),
    );
    expect(resultA.outcome).toBe("failed");
    if (resultA.outcome === "failed") expect(resultA.kind).toBe("massDelete");
    expect(server.getRows(handleA.tableId)).toHaveLength(4);
    expect(isJobPaused(jobA.id, dir)).toBe(true);

    // Sub-case B: the current scan sees zero keys at all — refuse regardless of maxDeletePercent.
    const handleB = server.createTable({ columns: [...baseColumns, { name: "modified_at", type: "DateTime", isKey: false }] });
    const jobB = baseJob(handleB, { id: "job-b" });
    const fingerprintB = computeJobFingerprint(jobB);

    const seedB = await runSync(
      baseOptions(jobB, handleB.pushKey, {
        readSourceRows: source([
          { id: 1, qty: 10, modified_at: "2026-01-01T00:05:00.000" },
          { id: 2, qty: 20, modified_at: "2026-01-01T00:05:00.000" },
        ]),
        delta: {
          watermarkColumn: "modified_at",
          overlapSeconds: 300,
          savedWatermark: undefined,
          forceReplace: false,
          isParamOverride: false,
          serverClockAtStart: "2026-01-01T00:10:00.000",
          fingerprint: fingerprintB,
        },
        reconciliation: { readKeyScanRows: source([]), maxDeletePercent: 100, allowMassDelete: false },
      }),
    );
    expect(seedB.outcome).toBe("completed");

    const resultB = await runSync(
      baseOptions(jobB, handleB.pushKey, {
        readSourceRows: source([]),
        delta: {
          watermarkColumn: "modified_at",
          overlapSeconds: 300,
          savedWatermark: "2026-01-01T00:06:00.000",
          forceReplace: false,
          isParamOverride: false,
          serverClockAtStart: "2026-01-01T00:20:00.000",
          fingerprint: fingerprintB,
        },
        reconciliation: { readKeyScanRows: source([]), maxDeletePercent: 100, allowMassDelete: false },
      }),
    );
    expect(resultB.outcome).toBe("failed");
    if (resultB.outcome === "failed") expect(resultB.kind).toBe("massDelete");
    expect(server.getRows(handleB.tableId)).toHaveLength(2);
    expect(isJobPaused(jobB.id, dir)).toBe(true);
  });

  it("Guard: no saved list, and a fingerprint mismatch against a saved list, both compute zero deletes and still succeed", async () => {
    // Sub-case A: no saved list has ever been written for this job.
    const handleA = server.createTable({ columns: [...baseColumns, { name: "modified_at", type: "DateTime", isKey: false }] });
    const jobA = baseJob(handleA, { id: "job-a" });
    const fingerprintA = computeJobFingerprint(jobA);

    const resultA = await runSync(
      baseOptions(jobA, handleA.pushKey, {
        readSourceRows: source([{ id: 5, qty: 50, modified_at: "2026-01-01T00:05:00.000" }]),
        delta: {
          watermarkColumn: "modified_at",
          overlapSeconds: 300,
          savedWatermark: "2026-01-01T00:00:00.000",
          forceReplace: false,
          isParamOverride: false,
          serverClockAtStart: "2026-01-01T00:10:00.000",
          fingerprint: fingerprintA,
        },
        reconciliation: { readKeyScanRows: source([{ id: 1 }]), maxDeletePercent: 20, allowMassDelete: false },
      }),
    );
    expect(resultA.outcome).toBe("completed");
    if (resultA.outcome !== "completed") return;
    expect(resultA.reconciliation?.deletesSent).toBe(0);

    // Sub-case B: a saved list exists, but under a different job fingerprint (e.g. the filter changed).
    const handleB = server.createTable({ columns: [...baseColumns, { name: "modified_at", type: "DateTime", isKey: false }] });
    const jobB = baseJob(handleB, { id: "job-b" });
    const oldFingerprint = computeJobFingerprint(jobB);

    const seedB = await runSync(
      baseOptions(jobB, handleB.pushKey, {
        readSourceRows: source([
          { id: 1, qty: 10, modified_at: "2026-01-01T00:05:00.000" },
          { id: 2, qty: 20, modified_at: "2026-01-01T00:05:00.000" },
        ]),
        delta: {
          watermarkColumn: "modified_at",
          overlapSeconds: 300,
          savedWatermark: undefined,
          forceReplace: false,
          isParamOverride: false,
          serverClockAtStart: "2026-01-01T00:10:00.000",
          fingerprint: oldFingerprint,
        },
        reconciliation: { readKeyScanRows: source([]), maxDeletePercent: 100, allowMassDelete: false },
      }),
    );
    expect(seedB.outcome).toBe("completed");

    const jobBAfterFilterChange: SyncJobEntry = { ...jobB, filter: [{ column: "qty", operator: "gt", value: 0 }] };
    const newFingerprint = computeJobFingerprint(jobBAfterFilterChange);
    expect(newFingerprint).not.toBe(oldFingerprint);

    const resultB = await runSync(
      baseOptions(jobBAfterFilterChange, handleB.pushKey, {
        readSourceRows: source([]),
        delta: {
          watermarkColumn: "modified_at",
          overlapSeconds: 300,
          savedWatermark: "2026-01-01T00:06:00.000",
          forceReplace: false,
          isParamOverride: false,
          serverClockAtStart: "2026-01-01T00:20:00.000",
          fingerprint: newFingerprint,
        },
        reconciliation: { readKeyScanRows: source([{ id: 1 }]), maxDeletePercent: 20, allowMassDelete: false },
      }),
    );
    expect(resultB.outcome).toBe("completed");
    if (resultB.outcome !== "completed") return;
    expect(resultB.reconciliation?.deletesSent).toBe(0);
    // Neither saved key (1 nor 2) was removed — the mismatched fingerprint made the old list "absent".
    expect(server.getRows(handleB.tableId)).toHaveLength(2);
  });

  it("Guard: no key value is ever written in plaintext to the on-disk saved key list", async () => {
    const handle = server.createTable({ columns: [...baseColumns, { name: "modified_at", type: "DateTime", isKey: false }] });
    const job = baseJob(handle, { id: "job-plain" });
    const fingerprint = computeJobFingerprint(job);

    const result = await runSync(
      baseOptions(job, handle.pushKey, {
        readSourceRows: source([
          { id: 4242, qty: 1, modified_at: "2026-01-01T00:05:00.000" },
          { id: 9191, qty: 2, modified_at: "2026-01-01T00:05:00.000" },
        ]),
        delta: {
          watermarkColumn: "modified_at",
          overlapSeconds: 300,
          savedWatermark: undefined,
          forceReplace: false,
          isParamOverride: false,
          serverClockAtStart: "2026-01-01T00:10:00.000",
          fingerprint,
        },
        reconciliation: { readKeyScanRows: source([]), maxDeletePercent: 100, allowMassDelete: false },
      }),
    );
    expect(result.outcome).toBe("completed");

    const files = collectFiles(path.join(dir, "key-reconciliation"));
    // meta.json plus at least one non-empty bucket file — otherwise this check would pass vacuously.
    expect(files.length).toBeGreaterThan(1);

    for (const file of files) {
      const raw = fs.readFileSync(file);
      expect(raw.includes(Buffer.from("4242", "utf8"))).toBe(false);
      expect(raw.includes(Buffer.from("9191", "utf8"))).toBe(false);
    }
  });
});
