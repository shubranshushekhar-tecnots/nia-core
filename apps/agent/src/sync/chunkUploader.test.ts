import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChunkRejectedError, PlanometryClient } from "../planometry/client.js";
import { HeartbeatScheduler } from "../planometry/heartbeatScheduler.js";
import { MASTER_KEY_LENGTH_BYTES } from "../secrets/crypto.js";
import { FakePlanometryServer } from "../testing/fakePlanometryServer.js";
import { uploadChunks } from "./chunkUploader.js";
import { encryptSpoolBuffer } from "./spoolCrypto.js";
import type { SpoolChunkFile } from "./spoolWriter.js";

describe("uploadChunks", () => {
  let server: FakePlanometryServer;
  let client: PlanometryClient;
  let dir: string;
  let heartbeat: HeartbeatScheduler;
  let masterKey: Buffer;

  beforeEach(async () => {
    server = await FakePlanometryServer.start();
    client = new PlanometryClient({ baseUrl: server.baseUrl, agentKey: "k", agentVersion: "0.0.1" });
    dir = await mkdtemp(path.join(tmpdir(), "nia-agent-chunkupload-"));
    heartbeat = new HeartbeatScheduler(60_000, () => {});
    masterKey = randomBytes(MASTER_KEY_LENGTH_BYTES);
  });

  afterEach(async () => {
    heartbeat.stop();
    await client.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function writeChunkFile(seq: number, rows: number, content: string): Promise<SpoolChunkFile> {
    const filePath = path.join(dir, `chunk-${seq}.gz`);
    await writeFile(filePath, encryptSpoolBuffer(masterKey, Buffer.from(content)));
    return { seq, rows, path: filePath };
  }

  it("uploads all chunks in order", async () => {
    server.enqueueWork("conn-1", { runId: "run-1", request: { table: "t", columns: ["a"], filter: [] } });
    await client.pollWork("conn-1");

    const files = [await writeChunkFile(0, 2, "a"), await writeChunkFile(1, 3, "b")];
    await uploadChunks(client, "run-1", files, masterKey, heartbeat);

    expect(server.getRun("run-1")).toMatchObject({ totalRows: 5, chunkCount: 2 });
  });

  it("retries a dropped chunk with the same seq", async () => {
    server.enqueueWork("conn-1", { runId: "run-1", request: { table: "t", columns: ["a"], filter: [] } });
    await client.pollWork("conn-1");
    server.setRunFaults("run-1", { dropOnFirstAttempt: new Set([0]) });

    const files = [await writeChunkFile(0, 2, "a")];
    await uploadChunks(client, "run-1", files, masterKey, heartbeat, { baseDelayMs: 1 });

    expect(server.getRun("run-1")).toMatchObject({ totalRows: 2, chunkCount: 1 });
  });

  it("throws ChunkRejectedError on a 409 without retrying", async () => {
    server.enqueueWork("conn-1", { runId: "run-1", request: { table: "t", columns: ["a"], filter: [] } });
    await client.pollWork("conn-1");
    server.setRunFaults("run-1", { force409: new Set([0]) });

    const files = [await writeChunkFile(0, 2, "a")];
    await expect(uploadChunks(client, "run-1", files, masterKey, heartbeat, { baseDelayMs: 1 })).rejects.toThrow(ChunkRejectedError);
    expect(server.getRun("run-1")?.chunkCount ?? 0).toBe(0);
  });

  it("fails clearly and never uploads when a spool file has been tampered with", async () => {
    server.enqueueWork("conn-1", { runId: "run-tamper", request: { table: "t", columns: ["a"], filter: [] } });
    await client.pollWork("conn-1");

    const file = await writeChunkFile(0, 2, "a");
    const raw = await readFile(file.path);
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff; // flip a byte in the trailing auth tag
    await writeFile(file.path, raw);

    await expect(uploadChunks(client, "run-tamper", [file], masterKey, heartbeat)).rejects.toThrow();
    expect(server.getRun("run-tamper")?.chunkCount ?? 0).toBe(0);
  });
});
