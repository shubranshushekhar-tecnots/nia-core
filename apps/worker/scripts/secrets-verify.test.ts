import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseMasterKey, encryptSecret, CURRENT_KEY_VERSION } from "@nia/secrets";
import { verifyOne } from "./secrets-verify.js";

const TEST_MASTER_KEY = parseMasterKey(Buffer.alloc(32, 3).toString("base64"));

interface FakeRow {
  ciphertext: string;
  encrypted_data_key: string;
  iv: string;
  auth_tag: string;
  algorithm: string;
  key_version: number;
}

/**
 * Minimal fake covering exactly the query shapes verifyOne uses:
 * nia_secrets select().eq().maybeSingle(), plus a resolve_connector_secret
 * RPC returning the CURRENT Vault value for a ref (independent of whatever
 * was encrypted into the nia_secrets row — that's what lets the mismatch
 * test simulate a stale/tampered migrated row).
 */
function createFakeClient(niaSecrets: Map<string, FakeRow>, vaultSecrets: Map<string, Record<string, unknown>>) {
  const client = {
    from(table: string) {
      if (table !== "nia_secrets") {
        throw new Error(`unexpected table "${table}" in fake`);
      }
      return {
        select(_cols: string) {
          return {
            eq(_col: string, value: string) {
              return {
                async maybeSingle() {
                  return { data: niaSecrets.get(value) ?? null, error: null };
                },
              };
            },
          };
        },
      };
    },
    async rpc(name: string, args: { p_ref: string }) {
      if (name !== "resolve_connector_secret") {
        throw new Error(`unexpected rpc "${name}" in fake`);
      }
      const secret = vaultSecrets.get(args.p_ref);
      if (!secret) {
        return { data: null, error: { message: `vault secret not found for ref ${args.p_ref}` } };
      }
      return { data: secret, error: null };
    },
  };

  return client as unknown as SupabaseClient;
}

function encryptedRow(secret: Record<string, unknown>): FakeRow {
  const encrypted = encryptSecret(TEST_MASTER_KEY, CURRENT_KEY_VERSION, secret);
  return {
    ciphertext: encrypted.ciphertext,
    encrypted_data_key: encrypted.encryptedDataKey,
    iv: encrypted.iv,
    auth_tag: encrypted.authTag,
    algorithm: encrypted.algorithm,
    key_version: encrypted.keyVersion,
  };
}

describe("verifyOne", () => {
  it("reports vault-only when no nia_secrets row exists for the ref", async () => {
    const client = createFakeClient(new Map(), new Map([["vault-ref-1", { user: "alice" }]]));

    expect(await verifyOne(client, TEST_MASTER_KEY, "vault-ref-1")).toBe("vault-only");
  });

  it("reports in-both-match when the migrated nia_secrets row decrypts to the current Vault value", async () => {
    const niaSecrets = new Map([["vault-ref-1", encryptedRow({ user: "alice", password: "hunter2" })]]);
    const client = createFakeClient(niaSecrets, new Map([["vault-ref-1", { user: "alice", password: "hunter2" }]]));

    expect(await verifyOne(client, TEST_MASTER_KEY, "vault-ref-1")).toBe("in-both-match");
  });

  it("detects a mismatch when the migrated nia_secrets row decrypts to a different value than Vault", async () => {
    // Simulates a stale/incorrectly-migrated row: nia_secrets holds a value
    // that no longer matches (or never matched) what Vault has for this ref.
    const niaSecrets = new Map([["vault-ref-1", encryptedRow({ user: "alice", password: "stale-password" })]]);
    const client = createFakeClient(niaSecrets, new Map([["vault-ref-1", { user: "alice", password: "hunter2" }]]));

    expect(await verifyOne(client, TEST_MASTER_KEY, "vault-ref-1")).toBe("in-both-mismatch");
  });
});
