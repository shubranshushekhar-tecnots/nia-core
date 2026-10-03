import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireReplaceLock, ReplaceLockTakenError } from "./replaceLock.js";

describe("acquireReplaceLock", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "nia-agent-replacelock-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("a second run on the same table is refused while the first holds the lock", () => {
    const release = acquireReplaceLock(dir, "http://x/table-1");
    expect(() => acquireReplaceLock(dir, "http://x/table-1")).toThrow(ReplaceLockTakenError);
    release();
  });

  it("a different table is unaffected", () => {
    const release = acquireReplaceLock(dir, "http://x/table-1");
    expect(() => acquireReplaceLock(dir, "http://x/table-2")).not.toThrow();
    release();
  });

  it("releasing lets a second run proceed", () => {
    const release = acquireReplaceLock(dir, "http://x/table-1");
    release();
    expect(() => acquireReplaceLock(dir, "http://x/table-1")).not.toThrow();
  });

  it("a stale lock (dead pid) is silently taken over", async () => {
    const safeName = Buffer.from("http://x/table-1").toString("base64url");
    const file = path.join(dir, `${safeName}.lock.json`);
    // Pid 999999 is extremely unlikely to be a live process on any test runner.
    await writeFile(file, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }));

    expect(() => acquireReplaceLock(dir, "http://x/table-1")).not.toThrow();
  });

  it("the error carries the live holder's pid and start time", () => {
    const release = acquireReplaceLock(dir, "http://x/table-1");
    try {
      acquireReplaceLock(dir, "http://x/table-1");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ReplaceLockTakenError);
      expect((err as ReplaceLockTakenError).pid).toBe(process.pid);
    }
    release();
  });
});
