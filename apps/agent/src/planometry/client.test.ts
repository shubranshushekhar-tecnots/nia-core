import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChunkRejectedError, PlanometryClient } from "./client.js";
import { FakePlanometryServer } from "../testing/fakePlanometryServer.js";

describe("PlanometryClient", () => {
  let server: FakePlanometryServer;
  let client: PlanometryClient;

  beforeEach(async () => {
    server = await FakePlanometryServer.start();
    client = new PlanometryClient({ baseUrl: server.baseUrl, agentKey: "test-key", agentVersion: "0.0.1" });
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("posts a catalog", async () => {
    await client.postCatalog({ connectionId: "conn-1", fingerprint: "abc", catalog: { generatedAt: "now", sourceTimeZone: "UTC", tables: [] } });
    expect(server.getCatalogPush("conn-1")?.fingerprint).toBe("abc");
  });

  it("polls work and gets null when the queue is empty", async () => {
    server.enqueueWork("conn-1", { runId: "run-1", request: { table: "t", columns: ["a"], filter: [] } });

    const first = await client.pollWork("conn-1");
    expect(first.work?.runId).toBe("run-1");

    const second = await client.pollWork("conn-1");
    expect(second.work).toBeNull();
  });

  it("pushes a chunk successfully", async () => {
    server.enqueueWork("conn-1", { runId: "run-1", request: { table: "t", columns: ["a"], filter: [] } });
    await client.pollWork("conn-1");

    await client.pushChunk("run-1", 0, 100, Buffer.from("gzip-bytes"));
    expect(server.getRun("run-1")).toMatchObject({ totalRows: 100, chunkCount: 1 });
  });

  it("throws ChunkRejectedError on a 409", async () => {
    server.enqueueWork("conn-1", { runId: "run-1", request: { table: "t", columns: ["a"], filter: [] } });
    await client.pollWork("conn-1");
    server.setRunFaults("run-1", { force409: new Set([0]) });

    await expect(client.pushChunk("run-1", 0, 10, Buffer.from("x"))).rejects.toThrow(ChunkRejectedError);
  });

  it("sends a heartbeat", async () => {
    server.enqueueWork("conn-1", { runId: "run-1", request: { table: "t", columns: ["a"], filter: [] } });
    await client.pollWork("conn-1");

    await client.heartbeat("run-1");
    expect(server.getRun("run-1")?.heartbeatCount).toBe(1);
  });

  it("reports complete and failed", async () => {
    server.enqueueWork("conn-1", { runId: "run-1", request: { table: "t", columns: ["a"], filter: [] } });
    await client.pollWork("conn-1");

    await client.reportComplete("run-1", { totalRows: 10, totalChunks: 1 });
    expect(server.getRun("run-1")?.complete).toEqual({ totalRows: 10, totalChunks: 1 });

    await client.reportFailed("run-1", { error: "boom" });
    expect(server.getRun("run-1")?.failed).toEqual({ error: "boom" });
  });
});
