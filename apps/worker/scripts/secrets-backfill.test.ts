import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseMasterKey, decryptSecret, type EncryptedSecret } from "@nia/secrets";
import { migrateOne } from "./secrets-backfill.js";
import type { SecretRefTask } from "./lib/secretsMigration.js";

const TEST_MASTER_KEY = parseMasterKey(Buffer.alloc(32, 7).toString("base64"));

interface FakeRow {
  id: string;
  ciphertext: string;
  encrypted_data_key: string;
  iv: string;
  auth_tag: string;
  algorithm: string;
  key_version: number;
  org_id: string | null;
  owner_id: string | null;
}

/**
 * Minimal fake covering exactly the nia_secrets query shapes migrateOne
 * uses (select().eq().maybeSingle()/single(), insert()) plus a
 * resolve_connector_secret RPC stub — same pattern as apps/api's
 * connections.test.ts/grants.test.ts fakes.
 */
function createFakeClient(vaultSecrets: Map<string, Record<string, unknown>>) {
  const niaSecrets = new Map<string, FakeRow>();

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
                  const row = niaSecrets.get(value);
                  return { data: row ? { id: row.id } : null, error: null };
                },
                async single() {
                  const row = niaSecrets.get(value);
                  if (!row) {
                    return { data: null, error: { message: "no row" } };
                  }
                  return { data: row, error: null };
                },
              };
            },
          };
        },
        async insert(row: Omit<FakeRow, "id"> & { id: string }) {
          niaSecrets.set(row.id, {
            id: row.id,
            ciphertext: row.ciphertext,
            encrypted_data_key: row.encrypted_data_key,
            iv: row.iv,
            auth_tag: row.auth_tag,
            algorithm: row.algorithm,
            key_version: row.key_version,
            org_id: row.org_id ?? null,
            owner_id: row.owner_id ?? null,
          });
          return { error: null };
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

  return { client: client as unknown as SupabaseClient, niaSecrets };
}

const baseTask: SecretRefTask = {
  ref: "vault-ref-1",
  table: "connections",
  rowId: "conn-1",
  scope: { org_id: "org-1", owner_id: null },
};

describe("migrateOne", () => {
  it("migrates a Vault-only ref: inserts nia_secrets under the same id, decryptable to the Vault value", async () => {
    const { client, niaSecrets } = createFakeClient(new Map([["vault-ref-1", { user: "alice", password: "hunter2" }]]));

    const result = await migrateOne(client, TEST_MASTER_KEY, baseTask);

    expect(result).toBe("migrated");
    expect(niaSecrets.size).toBe(1);
    const row = niaSecrets.get("vault-ref-1")!;
    expect(row.org_id).toBe("org-1");
    expect(row.owner_id).toBeNull();

    const encrypted: EncryptedSecret = {
      ciphertext: row.ciphertext,
      encryptedDataKey: row.encrypted_data_key,
      iv: row.iv,
      authTag: row.auth_tag,
      algorithm: row.algorithm,
      keyVersion: row.key_version,
    };
    expect(decryptSecret(TEST_MASTER_KEY, encrypted)).toEqual({ user: "alice", password: "hunter2" });
  });

  it("is idempotent: a second call for the same ref is a no-op, not a second insert", async () => {
    const { client, niaSecrets } = createFakeClient(new Map([["vault-ref-1", { user: "alice", password: "hunter2" }]]));

    const first = await migrateOne(client, TEST_MASTER_KEY, baseTask);
    expect(first).toBe("migrated");
    expect(niaSecrets.size).toBe(1);
    const firstRow = { ...niaSecrets.get("vault-ref-1")! };

    const second = await migrateOne(client, TEST_MASTER_KEY, baseTask);
    expect(second).toBe("already-migrated");
    expect(niaSecrets.size).toBe(1);
    // Re-running never re-encrypts/rewrites the row it already migrated.
    expect(niaSecrets.get("vault-ref-1")).toEqual(firstRow);
  });

  it("fails without inserting anything when the Vault resolve RPC has nothing for the ref", async () => {
    const { client, niaSecrets } = createFakeClient(new Map());

    const result = await migrateOne(client, TEST_MASTER_KEY, baseTask);

    expect(result).toBe("failed");
    expect(niaSecrets.size).toBe(0);
  });
});
