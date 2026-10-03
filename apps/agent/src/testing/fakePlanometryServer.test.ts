import { afterEach, describe, expect, it } from "vitest";
import { PlanometryClient, PlanometryRejectedError, PlanometryTransientError } from "../planometry/client.js";
import { FakePlanometryServer } from "./fakePlanometryServer.js";

const columns = [
  { name: "id", type: "Text" as const, isKey: true },
  { name: "qty", type: "Number" as const, isKey: false },
];

describe("FakePlanometryServer", () => {
  let server: FakePlanometryServer;

  afterEach(async () => {
    await server.close();
  });

  function clientFor(table: { tableUrl: string; pushKey: string }): PlanometryClient {
    return new PlanometryClient({ tableUrl: table.tableUrl, pushKey: table.pushKey });
  }

  it("unknown column returns 400 and writes nothing", async () => {
    server = await FakePlanometryServer.start();
    const table = server.createTable({ columns });
    const client = clientFor(table);

    await expect(client.push({ mode: "upsert", rows: [{ id: "a", bogus: 1 }] })).rejects.toBeInstanceOf(PlanometryRejectedError);
    expect(server.getRows(table.tableId)).toEqual([]);
    await client.close();
  });

  it("null key returns 400 and writes nothing", async () => {
    server = await FakePlanometryServer.start();
    const table = server.createTable({ columns });
    const client = clientFor(table);

    await expect(client.push({ mode: "upsert", rows: [{ id: null, qty: 1 }] })).rejects.toBeInstanceOf(PlanometryRejectedError);
    expect(server.getRows(table.tableId)).toEqual([]);
    await client.close();
  });

  it("over the row limit returns 400", async () => {
    server = await FakePlanometryServer.start();
    const table = server.createTable({ columns, maxRowsPerRequest: 2 });
    const client = clientFor(table);

    await expect(
      client.push({ mode: "upsert", rows: [{ id: "a" }, { id: "b" }, { id: "c" }] }),
    ).rejects.toBeInstanceOf(PlanometryRejectedError);
    expect(server.getRows(table.tableId)).toEqual([]);
    await client.close();
  });

  it("upsert last duplicate wins", async () => {
    server = await FakePlanometryServer.start();
    const table = server.createTable({ columns });
    const client = clientFor(table);

    const result = await client.push({
      mode: "upsert",
      rows: [
        { id: "a", qty: 1 },
        { id: "a", qty: 2 },
      ],
    });

    expect(result.rowsAffected).toBe(1);
    expect(server.getRows(table.tableId)).toEqual([{ id: "a", qty: 2 }]);
    await client.close();
  });

  it("delete by key", async () => {
    server = await FakePlanometryServer.start();
    const table = server.createTable({ columns });
    const client = clientFor(table);
    await client.push({
      mode: "upsert",
      rows: [
        { id: "a", qty: 1 },
        { id: "b", qty: 2 },
      ],
    });

    const result = await client.push({ mode: "delete", rows: [{ id: "a" }] });

    expect(result.rowsAffected).toBe(1);
    expect(server.getRows(table.tableId)).toEqual([{ id: "b", qty: 2 }]);
    await client.close();
  });

  it("realtime key in both lists ends up removed", async () => {
    server = await FakePlanometryServer.start();
    const table = server.createTable({ columns });
    const client = clientFor(table);

    const result = await client.push({
      mode: "realtime",
      rows: [{ id: "a", qty: 9 }],
      deleted: [{ id: "a" }],
    });

    expect(result.status).toBe("completed");
    expect(server.getRows(table.tableId)).toEqual([]);
    await client.close();
  });

  it("replace in parts keeps live rows until the last part", async () => {
    server = await FakePlanometryServer.start();
    const table = server.createTable({ columns });
    const client = clientFor(table);
    await client.push({ mode: "upsert", rows: [{ id: "old", qty: 1 }] });

    const part1 = await client.push({ mode: "replace", loadId: "load-1", rows: [{ id: "new1", qty: 1 }] });
    expect(part1).toMatchObject({ status: "accepted", loadId: "load-1", loadRowsReceived: 1 });
    expect(server.getRows(table.tableId)).toEqual([{ id: "old", qty: 1 }]);

    const part2 = await client.push({ mode: "replace", loadId: "load-1", rows: [{ id: "new2", qty: 2 }], last: true, totalRows: 2 });
    expect(part2.status).toBe("completed");
    expect(server.getRows(table.tableId).sort((a, b) => String(a.id).localeCompare(String(b.id)))).toEqual([
      { id: "new1", qty: 1 },
      { id: "new2", qty: 2 },
    ]);
    await client.close();
  });

  it("totalRows mismatch discards the load", async () => {
    server = await FakePlanometryServer.start();
    const table = server.createTable({ columns });
    const client = clientFor(table);

    await client.push({ mode: "replace", loadId: "load-1", rows: [{ id: "a", qty: 1 }] });
    await expect(
      client.push({ mode: "replace", loadId: "load-1", rows: [{ id: "b", qty: 2 }], last: true, totalRows: 99 }),
    ).rejects.toBeInstanceOf(PlanometryRejectedError);

    expect(server.getOpenLoad(table.tableId)).toBeUndefined();
    expect(server.getRows(table.tableId)).toEqual([]);
    await client.close();
  });

  it("a new loadId supersedes", async () => {
    server = await FakePlanometryServer.start();
    const table = server.createTable({ columns });
    const client = clientFor(table);

    await client.push({ mode: "replace", loadId: "load-1", rows: [{ id: "a", qty: 1 }] });
    await client.push({ mode: "replace", loadId: "load-2", rows: [{ id: "b", qty: 2 }] });

    const openLoad = server.getOpenLoad(table.tableId);
    expect(openLoad?.loadId).toBe("load-2");
    expect(openLoad?.loadRowsReceived).toBe(1);
    await client.close();
  });

  it("60 minutes idle discards", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    server = await FakePlanometryServer.start({ now: () => now });
    const table = server.createTable({ columns });
    const client = clientFor(table);

    await client.push({ mode: "replace", loadId: "load-1", rows: [{ id: "a", qty: 1 }] });
    now = new Date(now.getTime() + 61 * 60 * 1000);
    await client.push({ mode: "replace", loadId: "load-1", rows: [{ id: "b", qty: 2 }] });

    const openLoad = server.getOpenLoad(table.tableId);
    expect(openLoad?.loadRowsReceived).toBe(1);
    expect(openLoad?.rows).toEqual([{ id: "b", qty: 2 }]);
    await client.close();
  });

  it("the lost-response fault applies the request while the client sees a transient error", async () => {
    server = await FakePlanometryServer.start();
    const table = server.createTable({ columns });
    const client = clientFor(table);
    server.injectFault(table.tableId, "dropAfter");

    await expect(client.push({ mode: "upsert", rows: [{ id: "a", qty: 1 }] })).rejects.toBeInstanceOf(PlanometryTransientError);
    expect(server.getRows(table.tableId)).toEqual([{ id: "a", qty: 1 }]);
    await client.close();
  });

  it("a duplicate key within one request of a single-part replace returns 400 and leaves the table unchanged", async () => {
    server = await FakePlanometryServer.start();
    const table = server.createTable({ columns });
    const client = clientFor(table);
    await client.push({ mode: "upsert", rows: [{ id: "old", qty: 1 }] });

    await expect(
      client.push({
        mode: "replace",
        rows: [
          { id: "a", qty: 1 },
          { id: "a", qty: 2 },
        ],
      }),
    ).rejects.toBeInstanceOf(PlanometryRejectedError);

    expect(server.getRows(table.tableId)).toEqual([{ id: "old", qty: 1 }]);
    await client.close();
  });

  it("a duplicate key within one part of a multi-part replace returns 400 at last and leaves the table unchanged", async () => {
    server = await FakePlanometryServer.start();
    const table = server.createTable({ columns });
    const client = clientFor(table);
    await client.push({ mode: "upsert", rows: [{ id: "old", qty: 1 }] });

    await client.push({
      mode: "replace",
      loadId: "load-1",
      rows: [
        { id: "a", qty: 1 },
        { id: "a", qty: 2 },
      ],
    });
    await expect(
      client.push({ mode: "replace", loadId: "load-1", rows: [{ id: "b", qty: 3 }], last: true, totalRows: 3 }),
    ).rejects.toBeInstanceOf(PlanometryRejectedError);

    expect(server.getOpenLoad(table.tableId)).toBeUndefined();
    expect(server.getRows(table.tableId)).toEqual([{ id: "old", qty: 1 }]);
    await client.close();
  });

  it("a duplicate key across different parts of a multi-part replace returns 400 at last and leaves the table unchanged", async () => {
    server = await FakePlanometryServer.start();
    const table = server.createTable({ columns });
    const client = clientFor(table);
    await client.push({ mode: "upsert", rows: [{ id: "old", qty: 1 }] });

    await client.push({ mode: "replace", loadId: "load-1", rows: [{ id: "a", qty: 1 }] });
    await expect(
      client.push({ mode: "replace", loadId: "load-1", rows: [{ id: "a", qty: 2 }], last: true, totalRows: 2 }),
    ).rejects.toBeInstanceOf(PlanometryRejectedError);

    expect(server.getOpenLoad(table.tableId)).toBeUndefined();
    expect(server.getRows(table.tableId)).toEqual([{ id: "old", qty: 1 }]);
    await client.close();
  });
});
