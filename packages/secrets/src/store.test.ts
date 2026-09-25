import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { encryptSecret } from "./crypto.js";
import { createEnvKeySecretStore } from "./store.js";

/**
 * withServiceRole just runs its callback against a Queryable — this store's
 * logic doesn't depend on anything Postgres-specific, so a fake `query` is
 * enough; no real pg.Pool/transaction is needed.
 */
vi.mock("@nia/db", () => ({
  withServiceRole: vi.fn((_pool: unknown, fn: (db: { query: ReturnType<typeof vi.fn> }) => unknown) =>
    fn(mockDb),
  ),
}));

let mockDb: { query: ReturnType<typeof vi.fn> };

function fakePool(row: Record<string, unknown> | null) {
  mockDb = { query: vi.fn(async () => ({ rows: row ? [row] : [] })) };
  return {} as never;
}

describe("createEnvKeySecretStore", () => {
  const masterKey = randomBytes(32).toString("base64");

  it("resolves from nia_secrets when the row is present", async () => {
    const secret = { user: "sales_ro", password: "hunter2" };
    const encrypted = encryptSecret(Buffer.from(masterKey, "base64"), 1, secret);
    const row = {
      id: "abc",
      ciphertext: encrypted.ciphertext,
      encrypted_data_key: encrypted.encryptedDataKey,
      iv: encrypted.iv,
      auth_tag: encrypted.authTag,
      algorithm: encrypted.algorithm,
      key_version: encrypted.keyVersion,
    };

    const store = createEnvKeySecretStore({ pool: fakePool(row), masterKey });

    const result = await store.get("abc");

    expect(result).toEqual(secret);
  });

  it("returns null when absent from nia_secrets", async () => {
    const store = createEnvKeySecretStore({ pool: fakePool(null), masterKey });

    const result = await store.get("missing-ref");

    expect(result).toBeNull();
  });
});
