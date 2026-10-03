import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MASTER_KEY_LENGTH_BYTES } from "../secrets/crypto.js";
import { readReplaceSpool, removeReplaceSpool, ReplaceSpoolWriter } from "./replaceSpool.js";

describe("ReplaceSpoolWriter / readReplaceSpool", () => {
  let dir: string;
  let masterKey: Buffer;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "nia-agent-replacespool-"));
    masterKey = randomBytes(MASTER_KEY_LENGTH_BYTES);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function collect(runId: string): Promise<unknown[]> {
    const rows: unknown[] = [];
    for await (const row of readReplaceSpool(dir, runId, masterKey)) rows.push(row);
    return rows;
  }

  it("writes and re-reads rows in order from a single chunk", async () => {
    const spool = new ReplaceSpoolWriter(dir, "run-1", masterKey);
    await spool.prepare();
    spool.write({ id: 1 });
    spool.write({ id: 2 });
    spool.write({ id: 3 });
    await spool.finish();

    expect(await collect("run-1")).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("rotates to a new chunk file once the row threshold is crossed, and reads both in order", async () => {
    const spool = new ReplaceSpoolWriter(dir, "run-2", masterKey, { maxRows: 2 });
    await spool.prepare();
    for (let i = 1; i <= 5; i++) spool.write({ id: i });
    await spool.finish();

    expect(await collect("run-2")).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]);
  });

  it("rotates once the byte threshold is crossed", async () => {
    const spool = new ReplaceSpoolWriter(dir, "run-3", masterKey, { maxBytes: 64 });
    await spool.prepare();
    for (let i = 1; i <= 10; i++) spool.write({ id: i, pad: "x".repeat(20) });
    await spool.finish();

    expect(await collect("run-3")).toHaveLength(10);
  });

  it("is re-iterable — reading twice returns the same rows both times", async () => {
    const spool = new ReplaceSpoolWriter(dir, "run-4", masterKey);
    await spool.prepare();
    spool.write({ id: 1 });
    spool.write({ id: 2 });
    await spool.finish();

    expect(await collect("run-4")).toEqual([{ id: 1 }, { id: 2 }]);
    expect(await collect("run-4")).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("reading a run that never wrote anything yields no rows", async () => {
    expect(await collect("never-written")).toEqual([]);
  });

  it("removeReplaceSpool deletes every chunk file for the run", async () => {
    const spool = new ReplaceSpoolWriter(dir, "run-5", masterKey, { maxRows: 2 });
    await spool.prepare();
    for (let i = 1; i <= 5; i++) spool.write({ id: i });
    await spool.finish();

    await removeReplaceSpool(dir, "run-5");

    expect(await collect("run-5")).toEqual([]);
  });

  it("removeReplaceSpool is a no-op when nothing was ever written", async () => {
    await expect(removeReplaceSpool(dir, "never-written")).resolves.toBeUndefined();
  });

  it("different runIds in the same directory do not collide", async () => {
    const spoolA = new ReplaceSpoolWriter(dir, "run-a", masterKey);
    await spoolA.prepare();
    spoolA.write({ id: "a" });
    await spoolA.finish();

    const spoolB = new ReplaceSpoolWriter(dir, "run-b", masterKey);
    await spoolB.prepare();
    spoolB.write({ id: "b" });
    await spoolB.finish();

    expect(await collect("run-a")).toEqual([{ id: "a" }]);
    expect(await collect("run-b")).toEqual([{ id: "b" }]);
  });
});
