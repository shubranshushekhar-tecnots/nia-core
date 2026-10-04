import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncJobEntry } from "../config/types.js";
import { Logger } from "../ops/logger.js";
import { getLastWatermark, getLastWatermarkFingerprint, setLastWatermark } from "../ops/state.js";
import { FakePlanometryServer, type FakeTableHandle } from "../testing/fakePlanometryServer.js";
import { KeyedSemaphore } from "./concurrency.js";
import { runSync, type RunSyncOptions } from "./runSync.js";
import { computeJobFingerprint, computeNextWatermark, resolveSavedWatermark } from "./watermark.js";

/**
 * The unit tests required by docs/plans/planometry-v4-migration.md §10
 * (C1), item 7 (1 Allowed, 1 Refused, 2 Guard), plus the C1 follow-up's
 * two additions: the fingerprint rule (replacing the old "Guard" test 4)
 * and a dedicated `--param` override test. No containers — the fake
 * Planometry HTTP server (testing/fakePlanometryServer.ts) stands in for
 * Planometry.
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

function rowsSource(rows: Record<string, unknown>[]): RunSyncOptions["readSourceRows"] {
  return async (onRow, signal) => {
    for (const row of rows) {
      if (signal.aborted) return;
      onRow(row);
    }
  };
}

describe("upsertDelta (sync/watermark.ts, sync/runSync.ts, cli/jobCommands.ts)", () => {
  let dir: string;
  let server: FakePlanometryServer;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-agent-upsertdelta-"));
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
      readSourceRows: rowsSource([]),
      ...overrides,
    };
  }

  it("Allowed: an upsert run sends the given delta rows and advances the saved watermark after the push succeeds", async () => {
    const handle = server.createTable({ columns: [...baseColumns, { name: "modified_at", type: "DateTime", isKey: false }] });
    const job = baseJob(handle);
    const fingerprint = computeJobFingerprint(job);
    const savedWatermark = "2026-01-01T00:00:00.000";
    setLastWatermark(job.id, savedWatermark, fingerprint, dir);

    const result = await runSync(
      baseOptions(job, handle.pushKey, {
        readSourceRows: rowsSource([
          { id: 1, qty: 10, modified_at: "2026-01-01T00:05:00.000" },
          { id: 2, qty: 20, modified_at: "2026-01-01T00:08:00.000" },
        ]),
        delta: {
          watermarkColumn: "modified_at",
          overlapSeconds: 300,
          savedWatermark,
          forceReplace: false,
          isParamOverride: false,
          serverClockAtStart: "2026-01-01T00:10:00.000",
          fingerprint,
        },
      }),
    );

    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") return;
    expect(result.mode).toBe("upsert");
    expect(result.rowsSent).toBe(2);
    expect(server.getRows(handle.tableId)).toHaveLength(2);

    // Advanced (not left at the old saved value), and persisted to disk —
    // not just returned in the result.
    expect(result.watermarkAfter).toBeDefined();
    expect(result.watermarkAfter).not.toBe(savedWatermark);
    expect(getLastWatermark(job.id, dir)).toBe(result.watermarkAfter);
  });

  it("Refused: a run that fails partway through a multi-part upsert push leaves the saved watermark on disk unchanged", async () => {
    const handle = server.createTable({
      columns: [...baseColumns, { name: "modified_at", type: "DateTime", isKey: false }],
      maxRowsPerRequest: 2,
    });
    const job = baseJob(handle);
    const fingerprint = computeJobFingerprint(job);
    const savedWatermark = "2026-01-01T00:00:00.000";
    setLastWatermark(job.id, savedWatermark, fingerprint, dir);

    // Fault queue (FIFO, one per request against this table): a no-op delay
    // absorbs runSync's own getSchema call, a second no-op delay absorbs
    // the first (successful) upsert part, then a 400 fails the second part
    // — a genuine "succeeded partway, then failed" run.
    server.injectFault(handle.tableId, { type: "delay", ms: 0 });
    server.injectFault(handle.tableId, { type: "delay", ms: 0 });
    server.injectFault(handle.tableId, "400");

    const result = await runSync(
      baseOptions(job, handle.pushKey, {
        readSourceRows: rowsSource([
          { id: 1, qty: 10, modified_at: "2026-01-01T00:05:00.000" },
          { id: 2, qty: 20, modified_at: "2026-01-01T00:06:00.000" },
          { id: 3, qty: 30, modified_at: "2026-01-01T00:07:00.000" },
        ]),
        delta: {
          watermarkColumn: "modified_at",
          overlapSeconds: 300,
          savedWatermark,
          forceReplace: false,
          isParamOverride: false,
          serverClockAtStart: "2026-01-01T00:10:00.000",
          fingerprint,
        },
      }),
    );

    expect(result.outcome).toBe("failed");
    // Part 1 (2 rows) landed before part 2 failed — each upsert part stands alone.
    expect(server.getRows(handle.tableId)).toHaveLength(2);
    // The watermark must never be touched when the push didn't fully succeed.
    expect(getLastWatermark(job.id, dir)).toBe(savedWatermark);
  });

  it("Guard: computeNextWatermark is min(M, S) minus max(overlap, duration+60s), both when M trails S and when M leads S", () => {
    // M behind S (the common case: the watermark column lags the server clock).
    const behind = computeNextWatermark({
      maxSeen: "2026-01-01T00:08:00.000",
      serverClockAtStart: "2026-01-01T00:10:00.000",
      extractionDurationMs: 5_000,
      overlapSeconds: 300,
      isReplace: false,
    });
    // min(M, S) = M = 00:08:00.000; max(300, 5+60=65) = 300s.
    expect(behind).toBe("2026-01-01T00:03:00.000");

    // M ahead of S (e.g. clock skew on the source server between the
    // watermark write and runSync's own readServerClock call).
    const ahead = computeNextWatermark({
      maxSeen: "2026-01-01T00:12:00.000",
      serverClockAtStart: "2026-01-01T00:10:00.000",
      extractionDurationMs: 5_000,
      overlapSeconds: 300,
      isReplace: false,
    });
    // min(M, S) = S = 00:10:00.000; max(300, 65) = 300s.
    expect(ahead).toBe("2026-01-01T00:05:00.000");
  });

  it("Guard: after the filter changes, the saved watermark no longer matches and the next run is a replace", async () => {
    const handle = server.createTable({ columns: [...baseColumns, { name: "modified_at", type: "DateTime", isKey: false }] });
    const job = baseJob(handle);
    const oldFingerprint = computeJobFingerprint(job);
    setLastWatermark(job.id, "2026-01-01T00:00:00.000", oldFingerprint, dir);

    // The filter changes (same job otherwise) — its fingerprint no longer matches the one the saved watermark was computed against.
    const jobAfterFilterChange: SyncJobEntry = { ...job, filter: [{ column: "qty", operator: "gt", value: 0 }] };
    const newFingerprint = computeJobFingerprint(jobAfterFilterChange);
    expect(newFingerprint).not.toBe(oldFingerprint);

    // This is exactly cli/runJobCommand.ts's own resolution step: a
    // mismatched fingerprint means "treat the saved watermark as absent".
    const resolvedSavedWatermark = resolveSavedWatermark(
      { watermark: getLastWatermark(job.id, dir), fingerprint: getLastWatermarkFingerprint(job.id, dir) },
      newFingerprint,
    );
    expect(resolvedSavedWatermark).toBeUndefined();

    // And an undefined savedWatermark makes the next run a replace (sync/runSync.ts's pushMode resolution).
    const result = await runSync(
      baseOptions(jobAfterFilterChange, handle.pushKey, {
        readSourceRows: rowsSource([{ id: 1, qty: 10, modified_at: "2026-01-01T00:05:00.000" }]),
        delta: {
          watermarkColumn: "modified_at",
          overlapSeconds: 300,
          savedWatermark: resolvedSavedWatermark,
          forceReplace: false,
          isParamOverride: false,
          serverClockAtStart: "2026-01-01T00:10:00.000",
          fingerprint: newFingerprint,
        },
      }),
    );

    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") return;
    expect(result.mode).toBe("replace");
    // The new fingerprint is now the one saved, so the next run after this one can use the watermark again.
    expect(getLastWatermarkFingerprint(job.id, dir)).toBe(newFingerprint);
  });

  it("Param override: a --param override run on an upsertDelta job is sent as upsert and leaves the other rows and the saved watermark untouched", async () => {
    const handle = server.createTable({ columns: [...baseColumns, { name: "modified_at", type: "DateTime", isKey: false }] });
    const job = baseJob(handle);
    const fingerprint = computeJobFingerprint(job);

    // Seed the table + a saved watermark via a normal first run (replace, no saved watermark yet).
    const seed = await runSync(
      baseOptions(job, handle.pushKey, {
        readSourceRows: rowsSource([
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
      }),
    );
    expect(seed.outcome).toBe("completed");
    const savedWatermarkBefore = getLastWatermark(job.id, dir);
    const savedFingerprintBefore = getLastWatermarkFingerprint(job.id, dir);
    expect(savedWatermarkBefore).toBeDefined();

    // A --param override run (cli/runJobCommand.ts always sets isParamOverride
    // true + savedWatermark undefined for these, regardless of what's saved):
    // its narrower filter is already baked into readSourceRows by the caller —
    // this module never sees the filter itself, only the rows it's given.
    const result = await runSync(
      baseOptions(job, handle.pushKey, {
        readSourceRows: rowsSource([{ id: 1, qty: 999, modified_at: "2026-01-01T00:05:00.000" }]),
        delta: {
          watermarkColumn: "modified_at",
          overlapSeconds: 300,
          savedWatermark: undefined,
          forceReplace: false,
          isParamOverride: true,
          serverClockAtStart: "2026-01-01T00:20:00.000",
          fingerprint,
        },
      }),
    );

    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") return;
    expect(result.mode).toBe("upsert");

    // Row id=2 is untouched, row id=1 updated in place — never a replace-wipe.
    const rows = server.getRows(handle.tableId);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === "1")?.qty).toBe("999");
    expect(rows.find((r) => r.id === "2")?.qty).toBe("20");

    // The saved watermark (and its fingerprint) from the seed run are untouched by the override run.
    expect(getLastWatermark(job.id, dir)).toBe(savedWatermarkBefore);
    expect(getLastWatermarkFingerprint(job.id, dir)).toBe(savedFingerprintBefore);
  });
});
