import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, parseMasterKey } from "./crypto.js";

function freshMasterKey(): Buffer {
  return randomBytes(32);
}

describe("parseMasterKey", () => {
  it("accepts a valid 32-byte base64 key", () => {
    const raw = freshMasterKey().toString("base64");
    expect(() => parseMasterKey(raw)).not.toThrow();
  });

  it("throws a clear error when unset", () => {
    expect(() => parseMasterKey(undefined)).toThrow(/NIA_SECRET_MASTER_KEY is not set/);
    expect(() => parseMasterKey("")).toThrow(/NIA_SECRET_MASTER_KEY is not set/);
  });

  it("throws a clear error when the wrong length", () => {
    const tooShort = randomBytes(16).toString("base64");
    expect(() => parseMasterKey(tooShort)).toThrow(/must decode to exactly 32 bytes/);
  });
});

describe("encryptSecret / decryptSecret", () => {
  it("round trips: decrypting returns the original secret", () => {
    const masterKey = freshMasterKey();
    const secret = { user: "sales_ro", password: "correct horse battery staple", host: "db.internal" };

    const encrypted = encryptSecret(masterKey, 1, secret);
    const decrypted = decryptSecret(masterKey, encrypted);

    expect(decrypted).toEqual(secret);
  });

  it("fails to decrypt with the wrong master key, rather than returning garbage", () => {
    const masterKey = freshMasterKey();
    const wrongKey = freshMasterKey();
    const encrypted = encryptSecret(masterKey, 1, { password: "hunter2" });

    expect(() => decryptSecret(wrongKey, encrypted)).toThrow();
  });

  it("gives each secret a distinct IV, even for identical plaintext", () => {
    const masterKey = freshMasterKey();
    const secret = { password: "same-value" };

    const a = encryptSecret(masterKey, 1, secret);
    const b = encryptSecret(masterKey, 1, secret);

    expect(a.iv).not.toEqual(b.iv);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
    expect(a.encryptedDataKey).not.toEqual(b.encryptedDataKey);
  });

  it("rejects an unrecognized algorithm", () => {
    const masterKey = freshMasterKey();
    const encrypted = encryptSecret(masterKey, 1, { password: "x" });
    expect(() => decryptSecret(masterKey, { ...encrypted, algorithm: "aes-128-cbc" })).toThrow(
      /Unsupported secret algorithm/,
    );
  });
});
