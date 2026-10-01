import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Catalog } from "@nia/extract";
import type { NdjsonWriter } from "@nia/extract";
import { MASTER_KEY_LENGTH_BYTES } from "../secrets/crypto.js";

const connectMock = vi.fn();
const streamExtractMock = vi.fn();
vi.mock("@nia/extract/mssql", () => ({
  connect: (...args: unknown[]) => connectMock(...args),
  streamExtract: (...args: unknown[]) => streamExtractMock(...args),
}));

const { PlanometryClient } = await import("../planometry/client.js");
const { FakePlanometryServer } = await import("../testing/fakePlanometryServer.js");
const { KeyedSemaphore } = await import("./concurrency.js");
const { runSync } = await import("./runSync.js");

const catalog: Catalog = { generatedAt: "now", sourceTimeZone: "UTC", tables: [] };
const sqlConfig = { server: "db.internal", database: "sales", user: "u", password: "p" };
const masterKey = randomBytes(MASTER_KEY_LENGTH_BYTES);

describe("runSync", () => {
  let server: Awaited<ReturnType<typeof FakePlanometryServer.start>>;
  let client: InstanceType<typeof PlanometryClient>;
  let spoolDir: string;
  let fakePool: { close: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    server = await FakePlanometryServer.start();
    client = new PlanometryClient({ baseUrl: server.baseUrl, agentKey: "k", agentVersion: "0.0.1" });
    spoolDir = await mkdtemp(path.join(tmpdir(), "nia-agent-runsync-"));
    fakePool = { close: vi.fn().mockResolvedValue(undefined) };
    connectMock.mockReset().mockResolvedValue(fakePool);
    streamExtractMock.mockReset();
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    await rm(spoolDir, { recursive: true, force: true });
  });

  function freshSemaphores() {
    return { connectionSemaphore: new KeyedSemaphore(1), hostSemaphore: new KeyedSemaphore(1) };
  }

  it("reports complete, closes the pool before uploading, and cleans up the spool on success", async () => {
    const order: string[] = [];
    fakePool.close.mockImplementation(async () => {
      order.push("pool-closed");
    });
    const pushChunkSpy = vi.spyOn(client, "pushChunk");
    pushChunkSpy.mockImplementation(async (...args) => {
      order.push("chunk-uploaded");
      return PlanometryClient.prototype.pushChunk.apply(client, args as never);
    });

    streamExtractMock.mockImplementation(async (_pool: unknown, _catalog: unknown, _req: unknown, writer: NdjsonWriter) => {
      writer.writeColumns([{ name: "id", type: "number" }]);
      writer.writeRow([1]);
      writer.writeRow([2]);
      writer.writeEnd();
    });

    server.enqueueWork("conn-1", { runId: "run-ok", request: { table: "t", columns: ["id"], filter: [] } });
    const work = (await client.pollWork("conn-1")).work!;

    await runSync({ client, work, catalog, sqlConfig, connectionId: "conn-1", spoolDir, masterKey, ...freshSemaphores() });

    expect(order).toEqual(["pool-closed", "chunk-uploaded"]);
    expect(server.getRun("run-ok")?.complete).toEqual({ totalRows: 2, totalChunks: 1 });
    expect(existsSync(path.join(spoolDir, "run-ok"))).toBe(false);
  });

  it("reports failed and cleans up the spool when the extract itself errors", async () => {
    streamExtractMock.mockImplementation(async (_pool: unknown, _catalog: unknown, _req: unknown, writer: NdjsonWriter) => {
      writer.writeColumns([{ name: "id", type: "number" }]);
      writer.writeError("query timed out");
    });

    server.enqueueWork("conn-1", { runId: "run-fail", request: { table: "t", columns: ["id"], filter: [] } });
    const work = (await client.pollWork("conn-1")).work!;

    await runSync({ client, work, catalog, sqlConfig, connectionId: "conn-1", spoolDir, masterKey, ...freshSemaphores() });

    expect(server.getRun("run-fail")?.failed).toEqual({ error: "query timed out" });
    expect(fakePool.close).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(spoolDir, "run-fail"))).toBe(false);
  });

  it("stops and cleans up without reporting complete/failed when a chunk is rejected with 409", async () => {
    streamExtractMock.mockImplementation(async (_pool: unknown, _catalog: unknown, _req: unknown, writer: NdjsonWriter) => {
      writer.writeColumns([{ name: "id", type: "number" }]);
      writer.writeRow([1]);
      writer.writeEnd();
    });

    server.enqueueWork("conn-1", { runId: "run-409", request: { table: "t", columns: ["id"], filter: [] } });
    const work = (await client.pollWork("conn-1")).work!;
    server.setRunFaults("run-409", { force409: new Set([0]) });

    await runSync({ client, work, catalog, sqlConfig, connectionId: "conn-1", spoolDir, masterKey, ...freshSemaphores() });

    const run = server.getRun("run-409");
    expect(run?.complete).toBeUndefined();
    expect(run?.failed).toBeUndefined();
    expect(existsSync(path.join(spoolDir, "run-409"))).toBe(false);
  });
});
