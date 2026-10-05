import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SyncJobEntry } from "../config/types.js";
import { Logger } from "../ops/logger.js";
import { FakePlanometryServer, type FakeTableHandle } from "../testing/fakePlanometryServer.js";
import { bucketIndexFor, canonicalKeyString, readSavedBucketKeys, readSavedKeyListMeta } from "./keyReconciliation.js";
import { realtimeTick, type RealtimeTickOptions } from "./realtimeTick.js";

/**
 * The four unit tests required by docs/plans/planometry-v4-migration.md
 * §10 (E1), item 7: 1 Allowed, 3 Guard. No containers — the fake
 * Planometry HTTP server (testing/fakePlanometryServer.ts) stands in for
 * Planometry, and `readChangedRows`/`readKeyScanRows` are injected plain
 * async callbacks over in-memory arrays — no real timers, no clock.
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
    strategy: "realtime",
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

function rowsSource(rows: Record<string, unknown>[]): RealtimeTickOptions["readChangedRows"] {
  return async (onRow, signal) => {
    for (const row of rows) {
      if (signal.aborted) return;
      onRow(row);
    }
  };
}

describe("realtimeTick (sync/realtimeTick.ts, §1.3/E1)", () => {
  let dir: string;
  let server: FakePlanometryServer;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-agent-realtimetick-"));
    server = await FakePlanometryServer.start();
  });

  afterEach(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function baseOptions(job: SyncJobEntry, pushKey: string, overrides: Partial<RealtimeTickOptions> = {}): RealtimeTickOptions {
    return {
      job,
      pushKey,
      sourceColumnTypes: { id: "number", qty: "number", modified_at: "datetime" },
      dir,
      masterKey: Buffer.alloc(32),
      logger: silentLogger(),
      readChangedRows: rowsSource([]),
      watermarkColumn: "modified_at",
      overlapSeconds: 300,
      savedWatermark: "2026-01-01T00:00:00.000",
      serverClockAtStart: "2026-01-01T00:10:00.000",
      fingerprint: "fp-1",
      ...overrides,
    };
  }

  it("Allowed: a tick sends changed rows and deleted keys together in one realtime request", async () => {
    const handle = server.createTable({ columns: [...baseColumns, { name: "modified_at", type: "DateTime", isKey: false }] });
    const job = baseJob(handle, { deleteMode: "softDelete", softDeleteColumn: "flag" });

    const result = await realtimeTick(
      baseOptions(job, handle.pushKey, {
        softDelete: { column: "flag" },
        readChangedRows: rowsSource([
          { id: 1, qty: 10, modified_at: "2026-01-01T00:05:00.000", flag: false },
          { id: 2, qty: 20, modified_at: "2026-01-01T00:06:00.000", flag: true },
        ]),
      }),
    );

    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") return;
    expect(result.parts).toBe(1);
    expect(result.rowsUpserted).toBe(1);
    expect(result.rowsDeleted).toBe(1);
    expect(result.empty).toBe(false);

    const rows = server.getRows(handle.tableId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("1");
    expect(server.getVersion(handle.tableId)).toBe(1);
  });

  it("Guard: a key both changed and deleted in one tick is sent only in deleted", async () => {
    const handle = server.createTable({ columns: [...baseColumns, { name: "modified_at", type: "DateTime", isKey: false }] });
    const job = baseJob(handle, { deleteMode: "softDelete", softDeleteColumn: "flag" });

    const result = await realtimeTick(
      baseOptions(job, handle.pushKey, {
        softDelete: { column: "flag" },
        // Same key (id=5) seen twice in one tick's changed-row stream: once
        // unflagged (would land in upserts) and once flagged deleted. The
        // final dedup guard must leave it only in deleted.
        readChangedRows: rowsSource([
          { id: 5, qty: 1, modified_at: "2026-01-01T00:05:00.000", flag: false },
          { id: 5, qty: 2, modified_at: "2026-01-01T00:06:00.000", flag: true },
        ]),
      }),
    );

    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") return;
    expect(result.rowsUpserted).toBe(0);
    expect(result.rowsDeleted).toBe(1);
    expect(server.getRows(handle.tableId)).toHaveLength(0);
  });

  it("Guard: rows + deleted above the row limit are split into several requests, each within the limit", async () => {
    const handle = server.createTable({
      columns: [...baseColumns, { name: "modified_at", type: "DateTime", isKey: false }],
      maxRowsPerRequest: 3,
    });
    const job = baseJob(handle, { deleteMode: "softDelete", softDeleteColumn: "flag" });

    const result = await realtimeTick(
      baseOptions(job, handle.pushKey, {
        softDelete: { column: "flag" },
        readChangedRows: rowsSource([
          { id: 1, qty: 10, modified_at: "2026-01-01T00:05:00.000", flag: false },
          { id: 2, qty: 20, modified_at: "2026-01-01T00:06:00.000", flag: false },
          { id: 3, qty: 30, modified_at: "2026-01-01T00:07:00.000", flag: false },
          { id: 4, qty: 40, modified_at: "2026-01-01T00:08:00.000", flag: true },
          { id: 5, qty: 50, modified_at: "2026-01-01T00:09:00.000", flag: true },
        ]),
      }),
    );

    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") return;
    // 3 upserts + 2 deletes = 5 combined, over the limit of 3 -> 2 parts.
    // Each part staying within the limit is proven by the outcome itself:
    // the fake server rejects (400) any part exceeding maxRowsPerRequest,
    // which would have surfaced here as outcome "failed".
    expect(result.parts).toBe(2);
    expect(result.rowsUpserted).toBe(3);
    expect(result.rowsDeleted).toBe(2);
    expect(server.getRows(handle.tableId)).toHaveLength(3);
    expect(server.getVersion(handle.tableId)).toBe(2);
  });

  it("Guard: the key list comparison runs only when the reconcile interval has elapsed, and a tick in between still adds its upserted keys to the saved list", async () => {
    const handle = server.createTable({ columns: [...baseColumns, { name: "modified_at", type: "DateTime", isKey: false }] });
    const job = baseJob(handle, { deleteMode: "reconciliation" });

    // Tick 1: the reconcile interval hasn't elapsed — upserts id=1 only.
    // readKeyScanRows throws if ever invoked, proving the full scan+diff
    // never runs on a non-reconciling tick.
    const result1 = await realtimeTick(
      baseOptions(job, handle.pushKey, {
        readChangedRows: rowsSource([{ id: 1, qty: 10, modified_at: "2026-01-01T00:05:00.000" }]),
        reconciliation: {
          shouldReconcile: false,
          readKeyScanRows: async () => {
            throw new Error("readKeyScanRows must not be called when shouldReconcile is false");
          },
          maxDeletePercent: 100,
          allowMassDelete: false,
        },
      }),
    );

    expect(result1.outcome).toBe("completed");
    if (result1.outcome !== "completed") return;
    expect(result1.reconciled).toBe(false);
    expect(server.getRows(handle.tableId)).toHaveLength(1);

    const key1 = canonicalKeyString({ id: "1" });
    const bucket1 = bucketIndexFor(key1);
    const metaAfterTick1 = await readSavedKeyListMeta(dir, job.id);
    expect(metaAfterTick1?.totalKeys).toBe(1);
    expect(await readSavedBucketKeys(dir, job.id, bucket1, Buffer.alloc(32))).toContain(key1);

    // Tick 2: the interval has elapsed — the source now only has id=2
    // (id=1 disappeared since the last reconciling tick), so the full
    // scan+diff must delete id=1 and replace the saved list with id=2.
    const result2 = await realtimeTick(
      baseOptions(job, handle.pushKey, {
        readChangedRows: rowsSource([{ id: 2, qty: 20, modified_at: "2026-01-01T00:06:00.000" }]),
        reconciliation: {
          shouldReconcile: true,
          readKeyScanRows: rowsSource([{ id: 2, qty: 20, modified_at: "2026-01-01T00:06:00.000" }]),
          maxDeletePercent: 100,
          allowMassDelete: false,
        },
      }),
    );

    expect(result2.outcome).toBe("completed");
    if (result2.outcome !== "completed") return;
    expect(result2.reconciled).toBe(true);
    expect(result2.rowsUpserted).toBe(1);
    expect(result2.rowsDeleted).toBe(1);

    const rowsAfterTick2 = server.getRows(handle.tableId);
    expect(rowsAfterTick2).toHaveLength(1);
    expect(rowsAfterTick2[0]?.id).toBe("2");

    const metaAfterTick2 = await readSavedKeyListMeta(dir, job.id);
    expect(metaAfterTick2?.totalKeys).toBe(1);
  });
});
