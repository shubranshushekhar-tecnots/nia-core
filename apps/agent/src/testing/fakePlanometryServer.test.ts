import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakePlanometryServer } from "./fakePlanometryServer.js";
import { CHUNK_ROWS_HEADER, CHUNK_SEQ_HEADER } from "../planometry/types.js";

describe("FakePlanometryServer", () => {
  let server: FakePlanometryServer;

  beforeEach(async () => {
    server = await FakePlanometryServer.start();
  });

  afterEach(async () => {
    await server.close();
  });

  it("stores a catalog push", async () => {
    const res = await fetch(`${server.baseUrl}/v1/catalog`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId: "conn-1", fingerprint: "abc", catalog: { generatedAt: "now", sourceTimeZone: "UTC", tables: [] } }),
    });
    expect(res.status).toBe(200);
    expect(server.getCatalogPush("conn-1")?.fingerprint).toBe("abc");
  });

  it("returns queued work then null", async () => {
    server.enqueueWork("conn-1", { runId: "run-1", request: { table: "t", columns: ["a"], filter: [] } });

    const first = await (await fetch(`${server.baseUrl}/v1/work?connectionId=conn-1`)).json();
    expect(first.work.runId).toBe("run-1");

    const second = await (await fetch(`${server.baseUrl}/v1/work?connectionId=conn-1`)).json();
    expect(second.work).toBeNull();
    expect(second.pollAfterSeconds).toBeGreaterThan(0);
  });

  it("accepts a chunk and aggregates rows across chunks, ignoring a duplicate seq", async () => {
    server.enqueueWork("conn-1", { runId: "run-1", request: { table: "t", columns: ["a"], filter: [] } });
    await fetch(`${server.baseUrl}/v1/work?connectionId=conn-1`);

    await pushChunk(server.baseUrl, "run-1", 0, 100);
    await pushChunk(server.baseUrl, "run-1", 1, 50);
    // Duplicate delivery of seq 0 (e.g. agent retried after a lost ack) must not double-count.
    await pushChunk(server.baseUrl, "run-1", 0, 100);

    expect(server.getRun("run-1")).toMatchObject({ totalRows: 150, chunkCount: 2 });
  });

  it("drops the first attempt of a faulted seq, then accepts the retry with the same seq", async () => {
    server.enqueueWork("conn-1", { runId: "run-1", request: { table: "t", columns: ["a"], filter: [] } });
    await fetch(`${server.baseUrl}/v1/work?connectionId=conn-1`);
    server.setRunFaults("run-1", { dropOnFirstAttempt: new Set([0]) });

    await expect(pushChunk(server.baseUrl, "run-1", 0, 10)).rejects.toThrow();
    const retry = await pushChunkRaw(server.baseUrl, "run-1", 0, 10);
    expect(retry.status).toBe(200);
    expect(server.getRun("run-1")).toMatchObject({ totalRows: 10, chunkCount: 1 });
  });

  it("returns 409 for a faulted seq", async () => {
    server.enqueueWork("conn-1", { runId: "run-1", request: { table: "t", columns: ["a"], filter: [] } });
    await fetch(`${server.baseUrl}/v1/work?connectionId=conn-1`);
    server.setRunFaults("run-1", { force409: new Set([0]) });

    const res = await pushChunkRaw(server.baseUrl, "run-1", 0, 10);
    expect(res.status).toBe(409);
  });

  it("counts heartbeats and records complete/failed", async () => {
    server.enqueueWork("conn-1", { runId: "run-1", request: { table: "t", columns: ["a"], filter: [] } });
    await fetch(`${server.baseUrl}/v1/work?connectionId=conn-1`);

    await fetch(`${server.baseUrl}/v1/runs/run-1/heartbeat`, { method: "POST" });
    await fetch(`${server.baseUrl}/v1/runs/run-1/heartbeat`, { method: "POST" });
    await fetch(`${server.baseUrl}/v1/runs/run-1/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ totalRows: 10, totalChunks: 1 }),
    });

    const run = server.getRun("run-1");
    expect(run?.heartbeatCount).toBe(2);
    expect(run?.complete).toEqual({ totalRows: 10, totalChunks: 1 });
  });
});

async function pushChunkRaw(baseUrl: string, runId: string, seq: number, rows: number): Promise<Response> {
  return fetch(`${baseUrl}/v1/runs/${runId}/chunks`, {
    method: "POST",
    headers: { [CHUNK_SEQ_HEADER]: String(seq), [CHUNK_ROWS_HEADER]: String(rows) },
    body: Buffer.from("fake-gzip-bytes"),
  });
}

async function pushChunk(baseUrl: string, runId: string, seq: number, rows: number): Promise<void> {
  await pushChunkRaw(baseUrl, runId, seq, rows);
}
