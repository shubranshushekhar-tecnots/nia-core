import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlanometryClient } from "../planometry/client.js";
import type { PushRequestBody, TableSchema } from "../planometry/types.js";
import type { WireRow } from "../planometry/formatForTarget.js";
import { Logger } from "../ops/logger.js";
import { FakePlanometryServer } from "../testing/fakePlanometryServer.js";
import { replaceLoad } from "./replaceLoad.js";

const columns = [
  { name: "id", type: "Number" as const, isKey: true },
  { name: "qty", type: "Number" as const, isKey: false },
];

function rowsOf(rows: WireRow[]): () => AsyncIterable<WireRow> {
  return () =>
    (async function* () {
      for (const row of rows) yield row;
    })();
}

function silentLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;
}

async function schemaFor(server: FakePlanometryServer, table: { tableUrl: string; pushKey: string }): Promise<TableSchema> {
  const client = new PlanometryClient({ tableUrl: table.tableUrl, pushKey: table.pushKey });
  const schema = await client.getSchema();
  await client.close();
  return schema;
}

function pushBodies(spy: ReturnType<typeof vi.spyOn>): PushRequestBody[] {
  return spy.mock.calls.map((call) => {
    const body = call[0] as Buffer;
    return JSON.parse(gunzipSync(body).toString("utf8")) as PushRequestBody;
  });
}

function sortById(rows: { id: unknown }[]): { id: unknown }[] {
  return [...rows].sort((a, b) => Number(a.id) - Number(b.id));
}

describe("replaceLoad", () => {
  let server: FakePlanometryServer;

  afterEach(async () => {
    await server.close();
    vi.restoreAllMocks();
  });

  it("one-part replace sends no loadId and the table equals the source", async () => {
    server = await FakePlanometryServer.start();
    const table = server.createTable({ columns });
    const schemaAtStart = await schemaFor(server, table);
    const pushSpy = vi.spyOn(PlanometryClient.prototype, "push");

    const source = [
      { id: 1, qty: 10 },
      { id: 2, qty: 20 },
    ];
    const result = await replaceLoad({
      tableUrl: table.tableUrl,
      pushKey: table.pushKey,
      openRows: rowsOf(source),
      totalRows: source.length,
      schemaAtStart,
      logger: silentLogger(),
    });

    expect(result.outcome).toBe("completed");
    const bodies = pushBodies(pushSpy);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.loadId).toBeUndefined();
    expect(sortById(server.getRows(table.tableId) as { id: unknown }[])).toEqual(source);
  });

  it("120,001 rows go as 3 parts with one loadId and last + totalRows on the third only", async () => {
    server = await FakePlanometryServer.start();
    const table = server.createTable({ columns });
    const schemaAtStart = await schemaFor(server, table);
    const pushSpy = vi.spyOn(PlanometryClient.prototype, "push");

    const total = 120_001;
    const source = Array.from({ length: total }, (_, i) => ({ id: i, qty: i }));
    const result = await replaceLoad({
      tableUrl: table.tableUrl,
      pushKey: table.pushKey,
      openRows: rowsOf(source),
      totalRows: total,
      schemaAtStart,
      logger: silentLogger(),
    });

    expect(result.outcome).toBe("completed");
    const bodies = pushBodies(pushSpy);
    expect(bodies).toHaveLength(3);
    expect(bodies.map((b) => b.rows?.length)).toEqual([50_000, 50_000, 20_001]);
    expect(bodies.map((b) => b.last)).toEqual([false, false, true]);
    expect(bodies.map((b) => b.totalRows)).toEqual([undefined, undefined, total]);
    const loadIds = new Set(bodies.map((b) => b.loadId));
    expect(loadIds.size).toBe(1);
    expect([...loadIds][0]).toBeTruthy();
    expect(server.getRows(table.tableId)).toHaveLength(total);
  }, 30_000);

  it("a byte split under the row limit uses a loadId", async () => {
    server = await FakePlanometryServer.start();
    const bigColumns = [
      { name: "id", type: "Number" as const, isKey: true },
      { name: "pad", type: "Text" as const, isKey: false },
    ];
    const table = server.createTable({ columns: bigColumns });
    const schemaAtStart = await schemaFor(server, table);
    const pushSpy = vi.spyOn(PlanometryClient.prototype, "push");

    const pad = "x".repeat(600_000);
    const source = Array.from({ length: 120 }, (_, i) => ({ id: i, pad }));
    const result = await replaceLoad({
      tableUrl: table.tableUrl,
      pushKey: table.pushKey,
      openRows: rowsOf(source),
      totalRows: source.length,
      schemaAtStart,
      logger: silentLogger(),
    });

    expect(result.outcome).toBe("completed");
    const bodies = pushBodies(pushSpy);
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.every((b) => b.rows!.length < 50_000)).toBe(true);
    const loadIds = new Set(bodies.map((b) => b.loadId));
    expect(loadIds.size).toBe(1);
    expect(server.getRows(table.tableId)).toHaveLength(120);
  }, 30_000);

  it("live rows are unchanged until the last part", async () => {
    server = await FakePlanometryServer.start();
    const table = server.createTable({ columns, maxRowsPerRequest: 2 });
    const schemaAtStart = await schemaFor(server, table);
    const seedClient = new PlanometryClient({ tableUrl: table.tableUrl, pushKey: table.pushKey });
    await seedClient.push({ mode: "upsert", rows: [{ id: 999, qty: 0 }] });
    await seedClient.close();

    server.injectFault(table.tableId, { type: "delay", ms: 0 });
    server.injectFault(table.tableId, { type: "delay", ms: 300 });

    const source = [
      { id: 1, qty: 10 },
      { id: 2, qty: 20 },
      { id: 3, qty: 30 },
    ];
    const resultPromise = replaceLoad({
      tableUrl: table.tableUrl,
      pushKey: table.pushKey,
      openRows: rowsOf(source),
      totalRows: source.length,
      schemaAtStart,
      logger: silentLogger(),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.getRows(table.tableId)).toEqual([{ id: 999, qty: 0 }]);

    const result = await resultPromise;
    expect(result.outcome).toBe("completed");
    expect(sortById(server.getRows(table.tableId) as { id: unknown }[])).toEqual(source);
  });

  it("lost response on a middle part leads to one restart with a new loadId and success", async () => {
    server = await FakePlanometryServer.start();
    const table = server.createTable({ columns, maxRowsPerRequest: 1 });
    const schemaAtStart = await schemaFor(server, table);
    server.injectFault(table.tableId, "dropAfter");
    const pushSpy = vi.spyOn(PlanometryClient.prototype, "push");

    const source = [
      { id: 1, qty: 10 },
      { id: 2, qty: 20 },
    ];
    const result = await replaceLoad({
      tableUrl: table.tableUrl,
      pushKey: table.pushKey,
      openRows: rowsOf(source),
      totalRows: source.length,
      schemaAtStart,
      logger: silentLogger(),
    });

    expect(result.outcome).toBe("completed");
    const bodies = pushBodies(pushSpy);
    const loadIds = new Set(bodies.map((b) => b.loadId));
    expect(loadIds.size).toBe(2);
    expect(sortById(server.getRows(table.tableId) as { id: unknown }[])).toEqual(source);
  });

  it("a middle part dropped before apply is retried under the same loadId with no restart", async () => {
    server = await FakePlanometryServer.start();
    const table = server.createTable({ columns, maxRowsPerRequest: 1 });
    const schemaAtStart = await schemaFor(server, table);
    server.injectFault(table.tableId, "dropBefore");
    const pushSpy = vi.spyOn(PlanometryClient.prototype, "push");

    const source = [
      { id: 1, qty: 10 },
      { id: 2, qty: 20 },
    ];
    const result = await replaceLoad({
      tableUrl: table.tableUrl,
      pushKey: table.pushKey,
      openRows: rowsOf(source),
      totalRows: source.length,
      schemaAtStart,
      logger: silentLogger(),
    });

    expect(result.outcome).toBe("completed");
    const bodies = pushBodies(pushSpy);
    const loadIds = new Set(bodies.map((b) => b.loadId));
    expect(loadIds.size).toBe(1);
    expect(sortById(server.getRows(table.tableId) as { id: unknown }[])).toEqual(source);
  });

  it("a second mismatch stops the run with no third loadId", async () => {
    server = await FakePlanometryServer.start();
    const table = server.createTable({ columns, maxRowsPerRequest: 1 });
    const schemaAtStart = await schemaFor(server, table);
    server.injectFault(table.tableId, "dropAfter");
    server.injectFault(table.tableId, { type: "delay", ms: 0 });
    server.injectFault(table.tableId, "dropAfter");
    const pushSpy = vi.spyOn(PlanometryClient.prototype, "push");

    const source = [
      { id: 1, qty: 10 },
      { id: 2, qty: 20 },
    ];
    const result = await replaceLoad({
      tableUrl: table.tableUrl,
      pushKey: table.pushKey,
      openRows: rowsOf(source),
      totalRows: source.length,
      schemaAtStart,
      logger: silentLogger(),
    });

    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.error).toContain("restart");
    }
    const bodies = pushBodies(pushSpy);
    const loadIds = new Set(bodies.map((b) => b.loadId));
    expect(loadIds.size).toBe(2);
    // Live rows never touched: neither loadId's run ever reached the last part.
    expect(server.getRows(table.tableId)).toEqual([]);
  });

  it("last part applied but response lost is treated as completed with no resend", async () => {
    server = await FakePlanometryServer.start();
    const table = server.createTable({ columns });
    const schemaAtStart = await schemaFor(server, table);
    server.injectFault(table.tableId, "dropAfter");
    const pushSpy = vi.spyOn(PlanometryClient.prototype, "push");

    const source = [{ id: 1, qty: 10 }];
    const result = await replaceLoad({
      tableUrl: table.tableUrl,
      pushKey: table.pushKey,
      openRows: rowsOf(source),
      totalRows: source.length,
      schemaAtStart,
      logger: silentLogger(),
    });

    expect(result.outcome).toBe("completed");
    // No resend: exactly one push call for the single-part load.
    expect(pushSpy.mock.calls).toHaveLength(1);
    expect(server.getRows(table.tableId)).toEqual(source);
  });

  it("last part dropped before apply is resent and completes", async () => {
    server = await FakePlanometryServer.start();
    const table = server.createTable({ columns });
    const schemaAtStart = await schemaFor(server, table);
    server.injectFault(table.tableId, "dropBefore");
    const pushSpy = vi.spyOn(PlanometryClient.prototype, "push");

    const source = [{ id: 1, qty: 10 }];
    const result = await replaceLoad({
      tableUrl: table.tableUrl,
      pushKey: table.pushKey,
      openRows: rowsOf(source),
      totalRows: source.length,
      schemaAtStart,
      logger: silentLogger(),
    });

    expect(result.outcome).toBe("completed");
    // One push call that failed (dropBefore) plus one resend.
    expect(pushSpy.mock.calls).toHaveLength(2);
    expect(server.getRows(table.tableId)).toEqual(source);
  }, 150_000);

  it("400 mid-load stops with no retry and live rows unchanged", async () => {
    server = await FakePlanometryServer.start();
    const table = server.createTable({ columns, maxRowsPerRequest: 1 });
    const schemaAtStart = await schemaFor(server, table);
    const seedClient = new PlanometryClient({ tableUrl: table.tableUrl, pushKey: table.pushKey });
    await seedClient.push({ mode: "upsert", rows: [{ id: 999, qty: 0 }] });
    await seedClient.close();
    server.injectFault(table.tableId, "400");
    const pushSpy = vi.spyOn(PlanometryClient.prototype, "push");

    const source = [
      { id: 1, qty: 10 },
      { id: 2, qty: 20 },
    ];
    const result = await replaceLoad({
      tableUrl: table.tableUrl,
      pushKey: table.pushKey,
      openRows: rowsOf(source),
      totalRows: source.length,
      schemaAtStart,
      logger: silentLogger(),
    });

    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.consoleMessage).toContain("400");
    }
    expect(pushSpy.mock.calls).toHaveLength(1);
    expect(server.getRows(table.tableId)).toEqual([{ id: 999, qty: 0 }]);
  });

  it("401 stops with no retry", async () => {
    server = await FakePlanometryServer.start();
    const table = server.createTable({ columns });
    const schemaAtStart = await schemaFor(server, table);
    server.injectFault(table.tableId, "401");
    const pushSpy = vi.spyOn(PlanometryClient.prototype, "push");

    const source = [{ id: 1, qty: 10 }];
    const result = await replaceLoad({
      tableUrl: table.tableUrl,
      pushKey: table.pushKey,
      openRows: rowsOf(source),
      totalRows: source.length,
      schemaAtStart,
      logger: silentLogger(),
    });

    expect(result.outcome).toBe("failed");
    expect(pushSpy.mock.calls).toHaveLength(1);
    expect(server.getRows(table.tableId)).toEqual([]);
  });

  it("duplicate keys stop the run with live rows unchanged", async () => {
    server = await FakePlanometryServer.start();
    const table = server.createTable({ columns });
    const schemaAtStart = await schemaFor(server, table);
    const seedClient = new PlanometryClient({ tableUrl: table.tableUrl, pushKey: table.pushKey });
    await seedClient.push({ mode: "upsert", rows: [{ id: 999, qty: 0 }] });
    await seedClient.close();

    const source = [
      { id: 1, qty: 10 },
      { id: 1, qty: 20 },
    ];
    const result = await replaceLoad({
      tableUrl: table.tableUrl,
      pushKey: table.pushKey,
      openRows: rowsOf(source),
      totalRows: source.length,
      schemaAtStart,
      logger: silentLogger(),
    });

    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.consoleMessage).toContain("duplicate key");
    }
    expect(server.getRows(table.tableId)).toEqual([{ id: 999, qty: 0 }]);
  });

  it("the 55-minute limit stops the run (injected clock)", async () => {
    server = await FakePlanometryServer.start();
    const table = server.createTable({ columns, maxRowsPerRequest: 1 });
    const schemaAtStart = await schemaFor(server, table);

    const t0 = new Date("2026-01-01T00:00:00Z");
    let calls = 0;
    const now = () => {
      calls += 1;
      return calls <= 3 ? t0 : new Date(t0.getTime() + 56 * 60 * 1000);
    };

    const source = [
      { id: 1, qty: 10 },
      { id: 2, qty: 20 },
    ];
    const result = await replaceLoad({
      tableUrl: table.tableUrl,
      pushKey: table.pushKey,
      openRows: rowsOf(source),
      totalRows: source.length,
      schemaAtStart,
      logger: silentLogger(),
      now,
    });

    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.error).toContain("55 minutes");
    }
    expect(server.getRows(table.tableId)).toEqual([]);
  });
});
