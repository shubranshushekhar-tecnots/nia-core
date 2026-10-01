import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertDiskSpace, InsufficientDiskSpaceError } from "./diskSpace.js";

describe("assertDiskSpace", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "nia-agent-diskspace-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves when the real tmp filesystem has more than a trivial amount of free space", async () => {
    await expect(assertDiskSpace(dir, 1)).resolves.toBeUndefined();
  });

  it("throws InsufficientDiskSpaceError when requiring an impossibly large amount", async () => {
    await expect(assertDiskSpace(dir, Number.MAX_SAFE_INTEGER)).rejects.toThrow(InsufficientDiskSpaceError);
  });
});
