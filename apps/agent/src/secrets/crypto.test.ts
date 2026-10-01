import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt, MASTER_KEY_LENGTH_BYTES } from "./crypto.js";

describe("crypto", () => {
  it("round-trips arbitrary JSON-serializable data", () => {
    const key = randomBytes(MASTER_KEY_LENGTH_BYTES);
    const data = { user: "sa", password: "correct-horse-battery-staple" };
    const blob = encrypt(key, 1, data);
    expect(decrypt(key, blob)).toEqual(data);
  });

  it("fails to decrypt with the wrong key (authTag mismatch)", () => {
    const key = randomBytes(MASTER_KEY_LENGTH_BYTES);
    const wrongKey = randomBytes(MASTER_KEY_LENGTH_BYTES);
    const blob = encrypt(key, 1, { secret: "value" });
    expect(() => decrypt(wrongKey, blob)).toThrow();
  });

  it("rejects a master key of the wrong length", () => {
    const shortKey = randomBytes(16);
    expect(() => encrypt(shortKey, 1, {})).toThrow(/32 bytes/);
  });
});
