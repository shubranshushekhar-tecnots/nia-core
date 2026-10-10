import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MASTER_KEY_LENGTH_BYTES } from "../secrets/crypto.js";
import { defaultLocksDir, defaultSpoolDir } from "../config/paths.js";
import type { SyncJobEntry } from "../config/types.js";
import { Logger } from "../ops/logger.js";
import { FakePlanometryServer, type FakeTableHandle } from "../testing/fakePlanometryServer.js";
import { acquireReplaceLock } from "./replaceLock.js";
import { KeyedSemaphore } from "./concurrency.js";
import { runSync, type RunSyncOptions } from "./runSync.js";

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
    strategy: "replace",
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

function delayedRowsSource(rows: Record<string, unknown>[], delayMs: number): RunSyncOptions["readSourceRows"] {
  return async (onRow, signal) => {
    for (const row of rows) {
      if (signal.aborted) return;
      onRow(row);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  };
}

describe("runSync", () => {
  let dir: string;
  let masterKey: Buffer;
  let server: FakePlanometryServer;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "nia-agent-runsync-"));
    masterKey = randomBytes(MASTER_KEY_LENGTH_BYTES);
    server = await FakePlanometryServer.start();
  });

  afterEach(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  function baseOptions(job: SyncJobEntry, pushKey: string, overrides: Partial<RunSyncOptions> = {}): RunSyncOptions {
    return {
      job,
      pushKey,
      sourceColumnTypes: { id: "number", qty: "number" },
      dir,
      masterKey,
      tableSemaphore: new KeyedSemaphore(1),
      logger: silentLogger(),
      readSourceRows: rowsSource([
        { id: 1, qty: 10 },
        { id: 2, qty: 20 },
      ]),
      ...overrides,
    };
  }

  it("mapped column removed stops before extraction", async () => {
    const handle = server.createTable({ columns: baseColumns });
    server.updateTableSchema(handle.tableId, { columns: [baseColumns[0]!] });
    let extracted = false;
    const result = await runSync(
      baseOptions(baseJob(handle), handle.pushKey, {
        readSourceRows: async () => {
          extracted = true;
        },
      }),
    );
    expect(result.outcome).toBe("failed");
    expect(extracted).toBe(false);
    expect(server.getRows(handle.tableId)).toEqual([]);
  });

  it("replace not in supportedModes stops before extraction", async () => {
    const handle = server.createTable({ columns: baseColumns, supportedModes: ["upsert"] });
    let extracted = false;
    const result = await runSync(
      baseOptions(baseJob(handle), handle.pushKey, {
        readSourceRows: async () => {
          extracted = true;
        },
      }),
    );
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") expect(result.error).toContain("replace");
    expect(extracted).toBe(false);
    expect(server.getRows(handle.tableId)).toEqual([]);
  });

  it("a run is refused when free space is below the threshold", async () => {
    const handle = server.createTable({ columns: baseColumns });
    let extracted = false;
    const result = await runSync(
      baseOptions(baseJob(handle), handle.pushKey, {
        minFreeBytes: Number.MAX_SAFE_INTEGER,
        readSourceRows: async () => {
          extracted = true;
        },
      }),
    );
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") expect(result.error).toContain("insufficient free disk space");
    expect(extracted).toBe(false);
    expect(server.getRows(handle.tableId)).toEqual([]);
  });

  it("retyped stops", async () => {
    const handle = server.createTable({ columns: baseColumns });
    server.updateTableSchema(handle.tableId, {
      columns: [baseColumns[0]!, { name: "qty", type: "Text", isKey: false }],
    });
    let extracted = false;
    const result = await runSync(
      baseOptions(baseJob(handle), handle.pushKey, {
        readSourceRows: async () => {
          extracted = true;
        },
      }),
    );
    expect(result.outcome).toBe("failed");
    expect(extracted).toBe(false);
  });

  it("key change stops", async () => {
    const handle = server.createTable({ columns: baseColumns });
    server.updateTableSchema(handle.tableId, { keyColumns: ["qty"] });
    let extracted = false;
    const result = await runSync(
      baseOptions(baseJob(handle), handle.pushKey, {
        readSourceRows: async () => {
          extracted = true;
        },
      }),
    );
    expect(result.outcome).toBe("failed");
    expect(extracted).toBe(false);
  });

  it("new unmapped column warns and continues", async () => {
    const handle = server.createTable({
      columns: [...baseColumns, { name: "extra", type: "Text" as const, isKey: false }],
    });
    const warnings: string[] = [];
    const logger = {
      info: () => {},
      error: () => {},
      warn: (_event: string, fields?: Record<string, unknown>) => {
        if (fields?.message) warnings.push(String(fields.message));
      },
    } as unknown as Logger;
    const result = await runSync(baseOptions(baseJob(handle), handle.pushKey, { logger }));
    expect(result.outcome).toBe("completed");
    expect(warnings.some((w) => w.includes("extra"))).toBe(true);
  });

  it("null key with stop sends no request and reports the count", async () => {
    const handle = server.createTable({ columns: baseColumns });
    const result = await runSync(
      baseOptions(baseJob(handle, { onNullKey: "stop" }), handle.pushKey, {
        readSourceRows: rowsSource([
          { id: 1, qty: 10 },
          { id: null, qty: 20 },
          { id: 3, qty: 30 },
        ]),
      }),
    );
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") expect(result.error).toContain("1");
    expect(server.getRows(handle.tableId)).toEqual([]);
    expect(server.getOpenLoad(handle.tableId)).toBeUndefined();
  });

  it("null key with skip drops and counts and totalRows matches", async () => {
    const handle = server.createTable({ columns: baseColumns });
    const result = await runSync(
      baseOptions(baseJob(handle, { onNullKey: "skip" }), handle.pushKey, {
        readSourceRows: rowsSource([
          { id: 1, qty: 10 },
          { id: null, qty: 20 },
          { id: 3, qty: 30 },
        ]),
      }),
    );
    expect(result.outcome).toBe("completed");
    if (result.outcome === "completed") {
      expect(result.rowsSent).toBe(2);
      expect(result.rowsSkipped).toBe(1);
    }
    expect(server.getRows(handle.tableId)).toHaveLength(2);
  });

  it("empty-string key counts as null", async () => {
    const handle = server.createTable({ columns: baseColumns });
    const result = await runSync(
      baseOptions(baseJob(handle, { onNullKey: "skip" }), handle.pushKey, {
        readSourceRows: rowsSource([
          { id: 1, qty: 10 },
          { id: "", qty: 20 },
        ]),
      }),
    );
    expect(result.outcome).toBe("completed");
    if (result.outcome === "completed") {
      expect(result.rowsSent).toBe(1);
      expect(result.rowsSkipped).toBe(1);
    }
  });

  it("zero rows refused", async () => {
    const handle = server.createTable({ columns: baseColumns });
    const result = await runSync(
      baseOptions(baseJob(handle), handle.pushKey, {
        readSourceRows: rowsSource([]),
      }),
    );
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") expect(result.error).toContain("zero rows");
  });

  it("zero rows with --allow-empty-replace empties the table", async () => {
    const handle = server.createTable({ columns: baseColumns });
    const seeded = await runSync(baseOptions(baseJob(handle), handle.pushKey));
    expect(seeded.outcome).toBe("completed");
    expect(server.getRows(handle.tableId)).toHaveLength(2);

    const result = await runSync(
      baseOptions(baseJob(handle, { allowEmptyReplace: true }), handle.pushKey, {
        readSourceRows: rowsSource([]),
      }),
    );
    expect(result.outcome).toBe("completed");
    expect(server.getRows(handle.tableId)).toEqual([]);
  });

  it("a second run on a locked table is refused", async () => {
    const handle = server.createTable({ columns: baseColumns });
    const job = baseJob(handle);
    const release = acquireReplaceLock(defaultLocksDir(dir), job.targetUrl);
    try {
      const result = await runSync(baseOptions(job, handle.pushKey));
      expect(result.outcome).toBe("failed");
      if (result.outcome === "failed") expect(result.error).toContain("already in progress");
      expect(server.getRows(handle.tableId)).toEqual([]);
    } finally {
      release();
    }
  });

  it("a stale lock is taken over", async () => {
    const handle = server.createTable({ columns: baseColumns });
    const job = baseJob(handle);
    const locksDir = defaultLocksDir(dir);
    await mkdir(locksDir, { recursive: true });
    const safeName = Buffer.from(job.targetUrl).toString("base64url");
    await writeFile(
      path.join(locksDir, `${safeName}.lock.json`),
      JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }),
    );
    const result = await runSync(baseOptions(job, handle.pushKey));
    expect(result.outcome).toBe("completed");
    expect(server.getRows(handle.tableId)).toHaveLength(2);
  });

  it("the 400 message is on the console and not in the log", async () => {
    const handle = server.createTable({ columns: baseColumns });
    const logDir = await mkdtemp(path.join(tmpdir(), "nia-agent-runsync-log-"));
    const logger = new Logger(logDir);
    // The fake server's fault queue is consumed by whichever request (GET
    // /schema or POST push) reaches the table next — a harmless `delay`
    // filler absorbs runSync's own getSchema call first, so the "400"
    // lands on the push itself.
    server.injectFault(handle.tableId, { type: "delay", ms: 0 });
    server.injectFault(handle.tableId, "400");

    const result = await runSync(baseOptions(baseJob(handle), handle.pushKey, { logger }));

    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") expect(result.consoleMessage).toContain("fault injected: 400");

    const logText = await readFile(path.join(logDir, "agent.log"), "utf8");
    expect(logText).not.toContain("fault injected: 400");
    await rm(logDir, { recursive: true, force: true });
  });

  it("no key values appear in the log", async () => {
    const handle = server.createTable({ columns: baseColumns });
    const logDir = await mkdtemp(path.join(tmpdir(), "nia-agent-runsync-log2-"));
    const logger = new Logger(logDir);

    const result = await runSync(
      baseOptions(baseJob(handle), handle.pushKey, {
        logger,
        readSourceRows: rowsSource([
          { id: 741852, qty: 963 },
          { id: 852963, qty: 159 },
        ]),
      }),
    );
    expect(result.outcome).toBe("completed");

    const logText = await readFile(path.join(logDir, "agent.log"), "utf8");
    expect(logText).not.toContain("741852");
    expect(logText).not.toContain("852963");
    await rm(logDir, { recursive: true, force: true });
  });

  it("abort mid-run stops cleanly and removes the spool", async () => {
    const handle = server.createTable({ columns: baseColumns });
    const controller = new AbortController();
    const resultPromise = runSync(
      baseOptions(baseJob(handle), handle.pushKey, {
        signal: controller.signal,
        readSourceRows: delayedRowsSource(
          [
            { id: 1, qty: 10 },
            { id: 2, qty: 20 },
            { id: 3, qty: 30 },
          ],
          50,
        ),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    const result = await resultPromise;

    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") expect(result.error).toContain("aborted");
    const spoolFiles = await readdir(defaultSpoolDir(dir)).catch(() => []);
    expect(spoolFiles).toEqual([]);
    expect(server.getRows(handle.tableId)).toEqual([]);
  });

  /**
   * Regression coverage for the real "SQL Server -> Planometry" migration
   * path (the v3-era equivalent of this, sync/runSync.integration.test.ts,
   * was deleted during the v4 migration — see decisions.md's slice A1 test-
   * removal note — and never replaced with anything that exercises every
   * SQL Server native-type shape end to end again). Source row values here
   * are shaped exactly as packages/extract/src/mssql's real pipeline
   * produces them (nativeTypeMapping.ts's castToText rule + buildSelectSql.ts's
   * CONVERT/CAST expressions): decimal/money/bigint arrive as exact-digit
   * strings, int/float as native JS numbers, datetime2 as a no-offset
   * "yyyy-mm-dd hh:mi:ss.mmm" string, date as a plain "yyyy-mm-dd" string,
   * and bit as a native boolean — pushed through the real formatForTarget.ts
   * + requestBuilder.ts + replaceLoad.ts pipeline into a real (fake) server.
   */
  it("every SQL Server native-type shape survives a real push to Planometry", async () => {
    const columns = [
      { name: "id", type: "Number" as const, isKey: true },
      { name: "name", type: "Text" as const, isKey: false },
      { name: "priceDecimal", type: "Number" as const, isKey: false },
      { name: "priceMoney", type: "Number" as const, isKey: false },
      { name: "bigCount", type: "Number" as const, isKey: false },
      { name: "ratio", type: "Number" as const, isKey: false },
      { name: "isActive", type: "Boolean" as const, isKey: false },
      { name: "createdAt", type: "DateTime" as const, isKey: false },
      { name: "bornOn", type: "Date" as const, isKey: false },
    ];
    const handle = server.createTable({ columns });
    const job = baseJob(handle, {
      mapping: columns.map((c) => ({ source: c.name, target: c.name })),
      targetSchemaSnapshot: { columns, keyColumns: ["id"] },
    });

    const result = await runSync(
      baseOptions(job, handle.pushKey, {
        sourceColumnTypes: {
          id: "number",
          name: "text",
          priceDecimal: "number",
          priceMoney: "number",
          bigCount: "number",
          ratio: "number",
          isActive: "boolean",
          createdAt: "datetime",
          bornOn: "date",
        },
        sourceTimeZone: "UTC",
        readSourceRows: rowsSource([
          {
            id: 42,
            name: "Héllo 😀 Wörld",
            priceDecimal: "12345.6700", // decimal(10,4), CAST AS VARCHAR(MAX)
            priceMoney: "19.9900", // money, CONVERT(..., 2) — 4 decimal digits
            bigCount: "9223372036854775807", // bigint max, CAST AS VARCHAR(MAX)
            ratio: 3.14159, // float/real — driver-native JS number
            isActive: true, // bit — driver-native JS boolean
            createdAt: "2024-01-15 10:30:00.123", // datetime2, CONVERT(..., 121)
            bornOn: "2024-01-15",
          },
        ]),
      }),
    );

    expect(result.outcome).toBe("completed");
    // Every "Number" target column is wire-encoded as an exact-digit string
    // (formatForTarget.ts's plainNumericString), including a native-JS-number
    // source like this int `id` column — never a native JS number on the wire.
    expect(server.getRows(handle.tableId)).toEqual([
      {
        id: "42",
        name: "Héllo 😀 Wörld",
        priceDecimal: "12345.6700",
        priceMoney: "19.9900",
        bigCount: "9223372036854775807",
        ratio: "3.14159",
        isActive: true,
        createdAt: "2024-01-15T10:30:00.123Z",
        bornOn: "2024-01-15",
      },
    ]);
  });
});
