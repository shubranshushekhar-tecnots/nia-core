import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncJobEntry } from "../config/types.js";
import { Logger } from "../ops/logger.js";
import { getLastWatermark, setLastWatermark } from "../ops/state.js";
import { FakePlanometryServer, type FakeTableHandle } from "../testing/fakePlanometryServer.js";
import { KeyedSemaphore } from "./concurrency.js";
import { runSync, type RunSyncOptions } from "./runSync.js";
import { computeNextWatermark } from "./watermark.js";

/**
 * The 4 unit tests required by docs/plans/planometry-v4-migration.md
 * §10 (C1), item 7: 1 Allowed, 1 Refused, 2 Guard. No containers — the
 * fake Planometry HTTP server (testing/fakePlanometryServer.ts) stands
 * in for Planometry; `cli/jobCommands.ts`'s `@nia/extract/mssql` import
 * is mocked (same pattern as cli/jobCommands.test.ts) for the
 * `updateJob` guard test, which never actually needs a watermark-column
 * DB check since the job's strategy there stays "replace" — only the
 * unconditional "changed filter clears the saved watermark" side effect
 * is under test.
 */

const { connectMock, introspectCatalogMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  introspectCatalogMock: vi.fn(),
}));

vi.mock("@nia/extract/mssql", () => ({
  connect: connectMock,
  introspectCatalog: introspectCatalogMock,
}));

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
    const savedWatermark = "2026-01-01T00:00:00.000";
    setLastWatermark(job.id, savedWatermark, dir);

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
    const savedWatermark = "2026-01-01T00:00:00.000";
    setLastWatermark(job.id, savedWatermark, dir);

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

  it("Guard: updating a job's filter clears its saved watermark, forcing the next run to be a replace", async () => {
    const { addConnection } = await import("../cli/connectionCommands.js");
    const { addJob, updateJob } = await import("../cli/jobCommands.js");

    connectMock.mockReset();
    introspectCatalogMock.mockReset();
    connectMock.mockResolvedValue({ close: async () => {} });
    introspectCatalogMock.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      sourceTimeZone: "UTC",
      tables: [
        {
          name: "dbo.Sales",
          kind: "table",
          columns: [
            { name: "Id", type: "number", nullable: false },
            { name: "Qty", type: "number", nullable: true },
          ],
          excluded: [],
        },
      ],
    });

    addConnection(
      { id: "conn-1", label: "A", host: "h", database: "d", user: "u", password: "p", sourceTimeZone: "UTC", agentKey: "k" },
      dir,
    );
    const handle = server.createTable({
      columns: [
        { name: "Id", type: "Number", isKey: true },
        { name: "Qty", type: "Number", isKey: false },
      ],
    });

    const added = await addJob(
      { name: "Sales", connectionId: "conn-1", sourceTable: "dbo.Sales", targetUrl: handle.tableUrl, pushKey: handle.pushKey, mapOverrides: [] },
      {},
      dir,
    );
    expect(added.ok).toBe(true);
    const jobId = added.job!.id;

    setLastWatermark(jobId, "2026-01-01T00:00:00.000", dir);
    expect(getLastWatermark(jobId, dir)).toBeDefined();

    const updated = await updateJob(jobId, { filter: [{ column: "Qty", operator: "gt", value: 0 }] }, {}, dir);
    expect(updated.ok).toBe(true);
    expect(getLastWatermark(jobId, dir)).toBeUndefined();
  });
});
