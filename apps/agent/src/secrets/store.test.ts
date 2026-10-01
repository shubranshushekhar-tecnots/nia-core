import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSecretStore } from "./store.js";
import { MASTER_KEY_LENGTH_BYTES } from "./crypto.js";

describe("LocalSecretStore", () => {
  let dir: string;
  let store: LocalSecretStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-agent-secrets-"));
    store = new LocalSecretStore(randomBytes(MASTER_KEY_LENGTH_BYTES), dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a secret via its ref", () => {
    const ref = store.put({ user: "sa", password: "hunter2" });
    expect(store.get(ref)).toEqual({ user: "sa", password: "hunter2" });
  });

  it("returns null for an unknown ref", () => {
    expect(store.get("does-not-exist")).toBeNull();
  });

  it("deletes a secret", () => {
    const ref = store.put({ agentKey: "abc" });
    store.delete(ref);
    expect(store.get(ref)).toBeNull();
  });

  it("writes the backing file with owner-only permissions", () => {
    store.put({ a: 1 });
    const mode = fs.statSync(path.join(dir, "secrets.enc.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("persists across separate store instances sharing the same master key and dir", () => {
    const masterKey = randomBytes(MASTER_KEY_LENGTH_BYTES);
    const a = new LocalSecretStore(masterKey, dir);
    const ref = a.put({ value: "persisted" });
    const b = new LocalSecretStore(masterKey, dir);
    expect(b.get(ref)).toEqual({ value: "persisted" });
  });
});
