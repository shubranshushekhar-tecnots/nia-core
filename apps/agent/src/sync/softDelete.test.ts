import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SyncJobEntry } from "../config/types.js";
import { Logger } from "../ops/logger.js";
import { FakePlanometryServer, type FakeTableHandle } from "../testing/fakePlanometryServer.js";
import { KeyedSemaphore } from "./concurrency.js";
import { runSync, type RunSyncOptions } from "./runSync.js";
import { computeJobFingerprint } from "./watermark.js";

/**
 * The 2 unit tests required by docs/plans/planometry-v4-migration.md §10
 * (D2): 1 Allowed, 1 Guard. Template = sync/keyReconciliation.test.ts —
 * same fake Planometry HTTP server, no containers. Exercises `runSync`
 * end to end with `options.softDelete` set, not `sync/softDelete.ts`'s
 * own helpers directly (those are pure one-liners, exercised indirectly
 * here).
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
    deleteMode: "softDelete",
    softDeleteColumn: "is_deleted",
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

/** Same shape as `readSourceRows`: `(onRow, signal) => Promise<void>`. */
function source(rows: Record<string, unknown>[]) {
  return async (onRow: (row: Record<string, unknown>) => void, signal: AbortSignal) => {
    for (const row of rows) {
      if (signal.aborted) return;
      onRow(row);
    }
  };
}

describe("soft delete (sync/softDelete.ts, sync/deletePush.ts, sync/runSync.ts)", () => {
  let dir: string;
  let server: FakePlanometryServer;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-agent-softdelete-"));
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
      sourceColumnTypes: { id: "number", qty: "number", modified_at: "datetime", is_deleted: "boolean" },
      dir,
      masterKey: Buffer.alloc(32),
      tableSemaphore: new KeyedSemaphore(1),
      logger: silentLogger(),
      readSourceRows: source([]),
      ...overrides,
    };
  }

  it("Allowed: a changed row whose flag is true is sent as a delete and not as an upsert", async () => {
    const handle = server.createTable({ columns: [...baseColumns, { name: "modified_at", type: "DateTime", isKey: false }] });
    const job = baseJob(handle);
    const fingerprint = computeJobFingerprint(job);

    // Seed: first run, no saved watermark — a replace. Neither row is flagged.
    const seed = await runSync(
      baseOptions(job, handle.pushKey, {
        readSourceRows: source([
          { id: 1, qty: 10, modified_at: "2026-01-01T00:05:00.000", is_deleted: false },
          { id: 2, qty: 20, modified_at: "2026-01-01T00:06:00.000", is_deleted: false },
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
        softDelete: { column: "is_deleted" },
      }),
    );
    expect(seed.outcome).toBe("completed");
    expect(server.getRows(handle.tableId)).toHaveLength(2);

    // Delta run: only row 1 changed, and it's now flagged — it must be
    // sent as a delete (key only), never as an upsert of its new qty.
    const result = await runSync(
      baseOptions(job, handle.pushKey, {
        readSourceRows: source([{ id: 1, qty: 999, modified_at: "2026-01-01T00:20:00.000", is_deleted: true }]),
        delta: {
          watermarkColumn: "modified_at",
          overlapSeconds: 300,
          savedWatermark: "2026-01-01T00:06:00.000",
          forceReplace: false,
          isParamOverride: false,
          serverClockAtStart: "2026-01-01T00:25:00.000",
          fingerprint,
        },
        softDelete: { column: "is_deleted" },
      }),
    );

    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") return;
    expect(result.mode).toBe("upsert");
    // Nothing was upserted — the only changed row was classified as a delete.
    expect(result.rowsSent).toBe(0);
    expect(result.softDelete).toEqual({ deletesSent: 1 });

    const rows = server.getRows(handle.tableId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("2");
    // Row 1's qty (999) never reached the target — it was deleted, not upserted.
    expect(rows.some((r) => r.id === "1")).toBe(false);
  });

  it("Guard: a replace never sends a flagged row, and totalRows excludes it", async () => {
    const handle = server.createTable({ columns: [...baseColumns, { name: "modified_at", type: "DateTime", isKey: false }] });
    const job = baseJob(handle, { id: "job-replace" });
    const fingerprint = computeJobFingerprint(job);

    // First run (no saved watermark) is a replace — the job's normal
    // filter applies as always (simulated here as "every row the source
    // returns"), and the flagged row must be excluded from what's sent.
    const result = await runSync(
      baseOptions(job, handle.pushKey, {
        readSourceRows: source([
          { id: 1, qty: 10, modified_at: "2026-01-01T00:05:00.000", is_deleted: false },
          { id: 2, qty: 20, modified_at: "2026-01-01T00:05:00.000", is_deleted: true },
          { id: 3, qty: 30, modified_at: "2026-01-01T00:05:00.000", is_deleted: false },
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
        softDelete: { column: "is_deleted" },
      }),
    );

    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") return;
    expect(result.mode).toBe("replace");
    // totalRows (rowsSent) counts only the rows actually sent — the flagged row is excluded.
    expect(result.rowsSent).toBe(2);

    const rows = server.getRows(handle.tableId);
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.id === "2")).toBe(false);
  });
});
