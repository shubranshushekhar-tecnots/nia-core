import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrCreateMasterKey } from "./keyfile.js";
import { MASTER_KEY_LENGTH_BYTES } from "./crypto.js";

describe("keyfile", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-agent-keyfile-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates a new key file with owner-only permissions on first use", () => {
    const key = loadOrCreateMasterKey(dir);
    expect(key.length).toBe(MASTER_KEY_LENGTH_BYTES);

    const file = path.join(dir, "master.key");
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("returns the same key on subsequent calls", () => {
    const first = loadOrCreateMasterKey(dir);
    const second = loadOrCreateMasterKey(dir);
    expect(second).toEqual(first);
  });

  it("rejects an existing key file of the wrong length", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "master.key"), Buffer.from("too-short"), { mode: 0o600 });
    expect(() => loadOrCreateMasterKey(dir)).toThrow(/not a valid master key/);
  });
});
