import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSpoolUsage } from "./spoolUsage.js";

describe("getSpoolUsage", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "nia-agent-spool-usage-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports zero for a nonexistent spool dir", () => {
    expect(getSpoolUsage(path.join(dir, "missing"))).toEqual({ bytes: 0, fileCount: 0 });
  });

  it("reports zero for an empty spool dir", () => {
    expect(getSpoolUsage(dir)).toEqual({ bytes: 0, fileCount: 0 });
  });

  it("sums file sizes recursively across run subdirectories", async () => {
    const runDir = path.join(dir, "run-1");
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "chunk-0.ndjson.gz"), Buffer.alloc(100));
    await writeFile(path.join(runDir, "chunk-1.ndjson.gz"), Buffer.alloc(250));
    await writeFile(path.join(dir, "loose-file"), Buffer.alloc(10));

    expect(getSpoolUsage(dir)).toEqual({ bytes: 360, fileCount: 3 });
  });
});
