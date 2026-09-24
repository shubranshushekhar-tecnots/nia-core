import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { encryptSecret } from "./crypto.js";
import { createEnvKeySecretStore } from "./store.js";

/**
 * Minimal fake of the slice of SupabaseClient's fluent query builder this
 * store actually calls (`.from().select().eq().maybeSingle()`,
 * `.from().insert().select().single()`, `.from().delete().eq()`) — a real
 * SupabaseClient needs a live Postgres connection, and dual-read/backfill
 * logic doesn't depend on anything Postgres-specific.
 */
function fakeClient(row: Record<string, unknown> | null) {
  const client = {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({ data: row, error: null })),
        })),
      })),
      insert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn(async () => ({ data: { id: "new-id" }, error: null })),
        })),
      })),
      delete: vi.fn(() => ({
        eq: vi.fn(async () => ({ error: null })),
      })),
    })),
  };
  return client;
}

describe("createEnvKeySecretStore dual-read", () => {
  const masterKey = randomBytes(32).toString("base64");

  it("resolves from nia_secrets when the row is present, without calling legacyResolve", async () => {
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

    const legacyResolve = vi.fn(async () => ({ user: "should-not-be-used" }));
    const store = createEnvKeySecretStore({
      client: fakeClient(row) as never,
      masterKey,
      legacyResolve,
    });

    const result = await store.get("abc");

    expect(result).toEqual(secret);
    expect(legacyResolve).not.toHaveBeenCalled();
  });

  it("falls back to legacyResolve when nia_secrets has no matching row", async () => {
    const legacySecret = { user: "vault-only-user", password: "vault-pass" };
    const legacyResolve = vi.fn(async () => legacySecret);
    const store = createEnvKeySecretStore({
      client: fakeClient(null) as never,
      masterKey,
      legacyResolve,
    });

    const result = await store.get("legacy-ref");

    expect(result).toEqual(legacySecret);
    expect(legacyResolve).toHaveBeenCalledWith("legacy-ref");
  });

  it("returns null when absent from nia_secrets and no legacyResolve is configured", async () => {
    const store = createEnvKeySecretStore({
      client: fakeClient(null) as never,
      masterKey,
    });

    const result = await store.get("missing-ref");

    expect(result).toBeNull();
  });
});
