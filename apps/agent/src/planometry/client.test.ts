import { createServer, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakePlanometryServer } from "../testing/fakePlanometryServer.js";
import { PlanometryClient, PlanometryConfigError, PlanometryRejectedError, PlanometryTransientError } from "./client.js";

const columns = [
  { name: "invoice_no", type: "Text" as const, isKey: true },
  { name: "qty", type: "Number" as const, isKey: false },
];

describe("PlanometryClient", () => {
  let server: FakePlanometryServer;

  beforeEach(async () => {
    server = await FakePlanometryServer.start();
  });

  afterEach(async () => {
    await server.close();
  });

  it("checkConnection ok", async () => {
    const table = server.createTable({ columns });
    const client = new PlanometryClient({ tableUrl: table.tableUrl, pushKey: table.pushKey });

    const result = await client.checkConnection();

    expect(result).toMatchObject({ status: "ok", dataSourceId: table.tableId });
    await client.close();
  });

  it("getSchema returns columns, keys and maxRowsPerRequest", async () => {
    const table = server.createTable({ columns, maxRowsPerRequest: 123 });
    const client = new PlanometryClient({ tableUrl: table.tableUrl, pushKey: table.pushKey });

    const schema = await client.getSchema();

    expect(schema.columns).toEqual(columns);
    expect(schema.keyColumns).toEqual(["invoice_no"]);
    expect(schema.maxRowsPerRequest).toBe(123);
    await client.close();
  });

  it("upsert returns completed", async () => {
    const table = server.createTable({ columns });
    const client = new PlanometryClient({ tableUrl: table.tableUrl, pushKey: table.pushKey });

    const result = await client.push({ mode: "upsert", rows: [{ invoice_no: "INV-1", qty: 5 }] });

    expect(result).toMatchObject({ status: "completed", rowsAffected: 1 });
    await client.close();
  });

  it("POST carries Bearer and gzip", async () => {
    let capturedAuth: string | undefined;
    let capturedEncoding: string | undefined;
    let capturedBody: unknown;

    const raw: Server = createServer((req, res) => {
      capturedAuth = req.headers.authorization;
      capturedEncoding = req.headers["content-encoding"];
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const buf = Buffer.concat(chunks);
        capturedBody = JSON.parse(gunzipSync(buf).toString("utf8"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, data: { mode: "upsert", status: "completed" } }));
      });
    });
    await new Promise<void>((resolve) => raw.listen(0, "127.0.0.1", resolve));
    const address = raw.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const client = new PlanometryClient({ tableUrl: `http://127.0.0.1:${port}/t`, pushKey: "secret-key" });
    await client.push({ mode: "upsert", rows: [{ invoice_no: "INV-1" }] });
    await client.close();
    await new Promise<void>((resolve) => raw.close(() => resolve()));

    expect(capturedAuth).toBe("Bearer secret-key");
    expect(capturedEncoding).toBe("gzip");
    expect(capturedBody).toEqual({ mode: "upsert", rows: [{ invoice_no: "INV-1" }] });
  });

  it("401 gives a config error", async () => {
    const table = server.createTable({ columns });
    const client = new PlanometryClient({ tableUrl: table.tableUrl, pushKey: "wrong-key" });

    await expect(client.checkConnection()).rejects.toThrow(PlanometryConfigError);
    await client.close();
  });

  it("404 gives a config error", async () => {
    const tableA = server.createTable({ columns });
    server.createTable({ columns });
    const client = new PlanometryClient({ tableUrl: `${server.baseUrl}/api/datasources/internal-tables/ds-does-not-match`, pushKey: tableA.pushKey });

    await expect(client.checkConnection()).rejects.toThrow(PlanometryConfigError);
    await client.close();
  });

  it("400 gives rejected with the server message", async () => {
    const table = server.createTable({ columns });
    const client = new PlanometryClient({ tableUrl: table.tableUrl, pushKey: table.pushKey });

    await expect(client.push({ mode: "upsert", rows: [{ invoice_no: "INV-1", not_a_column: 1 }] })).rejects.toThrow(/unknown column/);
    await expect(client.push({ mode: "upsert", rows: [{ invoice_no: "INV-1", not_a_column: 1 }] })).rejects.toBeInstanceOf(PlanometryRejectedError);
    await client.close();
  });

  it("500 gives transient", async () => {
    const table = server.createTable({ columns });
    server.injectFault(table.tableId, "500");
    const client = new PlanometryClient({ tableUrl: table.tableUrl, pushKey: table.pushKey });

    await expect(client.checkConnection()).rejects.toThrow(PlanometryTransientError);
    await client.close();
  });

  it("a dropped connection gives transient", async () => {
    const table = server.createTable({ columns });
    server.injectFault(table.tableId, "dropBefore");
    const client = new PlanometryClient({ tableUrl: table.tableUrl, pushKey: table.pushKey });

    await expect(client.checkConnection()).rejects.toThrow(PlanometryTransientError);
    await client.close();
  });

  it("the push key is absent from every error", async () => {
    const table = server.createTable({ columns });
    const pushKey = table.pushKey;

    const wrongKeyClient = new PlanometryClient({ tableUrl: table.tableUrl, pushKey: "wrong-key" });
    const err401 = await wrongKeyClient.checkConnection().catch((e: Error) => e);
    await wrongKeyClient.close();

    const client = new PlanometryClient({ tableUrl: table.tableUrl, pushKey });
    server.injectFault(table.tableId, "500");
    const err500 = await client.checkConnection().catch((e: Error) => e);
    server.injectFault(table.tableId, "dropBefore");
    const errDrop = await client.checkConnection().catch((e: Error) => e);
    const err400 = await client.push({ mode: "upsert", rows: [{ invoice_no: "INV-1", bogus: 1 }] }).catch((e: Error) => e);
    await client.close();

    for (const err of [err401, err500, errDrop, err400]) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain(pushKey);
      expect(String(err)).not.toContain(pushKey);
    }
  });
});
