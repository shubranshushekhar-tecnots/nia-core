import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NdjsonWriter } from "@nia/extract";
import { MASTER_KEY_LENGTH_BYTES } from "../secrets/crypto.js";
import { decryptSpoolBuffer } from "./spoolCrypto.js";
import { SpoolWriter } from "./spoolWriter.js";

async function readChunkLines(filePath: string, masterKey: Buffer): Promise<string[]> {
  const raw = await readFile(filePath);
  const gz = decryptSpoolBuffer(masterKey, raw);
  const text = zlib.gunzipSync(gz).toString("utf8");
  return text.split("\n").filter(Boolean);
}

describe("SpoolWriter", () => {
  let dir: string;
  let masterKey: Buffer;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "nia-agent-spool-"));
    masterKey = randomBytes(MASTER_KEY_LENGTH_BYTES);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("spools all rows into a single chunk file when under the row threshold", async () => {
    const spool = new SpoolWriter(dir, "run-1", masterKey);
    await spool.prepare();
    const writer = new NdjsonWriter(spool.write);

    writer.writeColumns([{ name: "id", type: "number" }]);
    writer.writeRow([1]);
    writer.writeRow([2]);
    writer.writeRow([3]);
    writer.writeEnd();

    const { files, result } = await spool.finish();
    expect(result).toEqual({ ok: true, totalRows: 3 });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ seq: 0, rows: 3 });

    const lines = await readChunkLines(files[0]!.path, masterKey);
    expect(lines).toHaveLength(4); // columns + 3 rows, no trailer
    expect(JSON.parse(lines[0]!)).toEqual({ columns: [{ name: "id", type: "number" }] });
    expect(lines.slice(1).map((l) => JSON.parse(l))).toEqual([[1], [2], [3]]);
  });

  it("rotates to a new self-contained chunk file once the row threshold is crossed", async () => {
    const spool = new SpoolWriter(dir, "run-2", masterKey, { maxRows: 2 });
    await spool.prepare();
    const writer = new NdjsonWriter(spool.write);

    writer.writeColumns([{ name: "id", type: "number" }]);
    for (let i = 1; i <= 5; i++) writer.writeRow([i]);
    writer.writeEnd();

    const { files, result } = await spool.finish();
    expect(result).toEqual({ ok: true, totalRows: 5 });
    expect(files.map((f) => f.rows)).toEqual([2, 2, 1]);

    for (const file of files) {
      const lines = await readChunkLines(file.path, masterKey);
      expect(JSON.parse(lines[0]!)).toEqual({ columns: [{ name: "id", type: "number" }] });
      expect(lines).toHaveLength(file.rows + 1);
    }
  });

  it("captures the error trailer instead of a chunk rotation", async () => {
    const spool = new SpoolWriter(dir, "run-3", masterKey);
    await spool.prepare();
    const writer = new NdjsonWriter(spool.write);

    writer.writeColumns([{ name: "id", type: "number" }]);
    writer.writeRow([1]);
    writer.writeError("boom");

    const { result, files } = await spool.finish();
    expect(result).toEqual({ ok: false, error: "boom" });
    expect(files).toHaveLength(1);
    expect(files[0]!.rows).toBe(1);
  });

  it("ignores keep-alive lines", async () => {
    const spool = new SpoolWriter(dir, "run-4", masterKey);
    await spool.prepare();
    const writer = new NdjsonWriter(spool.write);

    writer.writeColumns([{ name: "id", type: "number" }]);
    writer.writeRow([1]);
    spool.write("\n");
    writer.writeEnd();

    const { files } = await spool.finish();
    const lines = await readChunkLines(files[0]!.path, masterKey);
    expect(lines).toHaveLength(2); // columns + 1 row, keep-alive not persisted
  });

  it("encrypts chunk files at rest — not readable as gzip without the master key", async () => {
    const spool = new SpoolWriter(dir, "run-5", masterKey);
    await spool.prepare();
    const writer = new NdjsonWriter(spool.write);

    writer.writeColumns([{ name: "id", type: "number" }]);
    writer.writeRow([1]);
    writer.writeEnd();

    const { files } = await spool.finish();
    const raw = await readFile(files[0]!.path);
    expect(() => zlib.gunzipSync(raw)).toThrow();

    const wrongKey = randomBytes(MASTER_KEY_LENGTH_BYTES);
    expect(() => decryptSpoolBuffer(wrongKey, raw)).toThrow();

    const lines = await readChunkLines(files[0]!.path, masterKey);
    expect(JSON.parse(lines[0]!)).toEqual({ columns: [{ name: "id", type: "number" }] });
  });
});
