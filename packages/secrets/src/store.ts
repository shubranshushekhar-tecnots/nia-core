import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret, encryptSecret, parseMasterKey, type EncryptedSecret } from "./crypto.js";

/**
 * Same org_id/owner_id xor shape as every other workspace-scoped table
 * (0007_connectors.sql). Deliberately a local type, not a reuse of
 * apps/api's WorkspaceScope: this package must stay import-free of any app,
 * so callers translate at the boundary.
 */
export type SecretScope = { orgId: string } | { ownerId: string };

/**
 * One interface for the whole app, per docs/plans/secret-storage.md Step 2A:
 * an Azure Key Vault (or any other) implementation can be added later behind
 * this same interface without touching a single stored secret, since only
 * how encryptedDataKey is protected would change.
 */
export interface SecretStore {
  /** Resolves `ref` to its decrypted secret. Returns null if `ref` doesn't exist in nia_secrets. */
  get(ref: string): Promise<Record<string, unknown> | null>;
  /** Envelope-encrypts `secret` and inserts a new nia_secrets row scoped to `scope`. Returns the new row's id. */
  put(secret: Record<string, unknown>, scope: SecretScope): Promise<string>;
  /** Deletes a nia_secrets row by id. No-op (not an error) if it doesn't exist. */
  delete(ref: string): Promise<void>;
}

interface NiaSecretRow {
  id: string;
  ciphertext: string;
  encrypted_data_key: string;
  iv: string;
  auth_tag: string;
  algorithm: string;
  key_version: number;
}

/**
 * Bumped only when a full re-encryption/rotation format changes — see
 * rotation TODO. Exported so one-off tooling that writes nia_secrets rows
 * outside of a SecretStore instance (apps/worker/scripts/secrets-backfill.ts)
 * can't drift from the value real traffic uses.
 */
export const CURRENT_KEY_VERSION = 1;

export interface CreateEnvKeySecretStoreOptions {
  /** A per-request (RLS-scoped) or service-role Supabase client — nia_secrets RLS gates the former exactly like connections. */
  client: SupabaseClient;
  /** Raw NIA_SECRET_MASTER_KEY value; validated eagerly so a malformed key fails fast at store-construction time. */
  masterKey: string;
}

/** The env-key SecretStore implementation: NIA_SECRET_MASTER_KEY from process env, backed by the nia_secrets table. */
export function createEnvKeySecretStore(opts: CreateEnvKeySecretStoreOptions): SecretStore {
  const masterKey = parseMasterKey(opts.masterKey);

  return {
    async get(ref) {
      const { data, error } = await opts.client
        .from("nia_secrets")
        .select("id, ciphertext, encrypted_data_key, iv, auth_tag, algorithm, key_version")
        .eq("id", ref)
        .maybeSingle<NiaSecretRow>();

      if (error) {
        throw new Error(`nia_secrets read failed for ${ref}: ${error.message}`);
      }

      if (data) {
        const encrypted: EncryptedSecret = {
          ciphertext: data.ciphertext,
          encryptedDataKey: data.encrypted_data_key,
          iv: data.iv,
          authTag: data.auth_tag,
          algorithm: data.algorithm,
          keyVersion: data.key_version,
        };
        return decryptSecret(masterKey, encrypted);
      }

      return null;
    },

    async put(secret, scope) {
      const encrypted = encryptSecret(masterKey, CURRENT_KEY_VERSION, secret);
      // Both keys always present (one undefined) rather than spread
      // conditionally: supabase-js's insert() overload infers its
      // excess-property check from the first row's own shape, which chokes
      // on a row typed as a union of two disjoint object shapes. undefined
      // values are dropped from the JSON payload PostgREST receives, so
      // this has no effect on which column actually gets written.
      const row = {
        ciphertext: encrypted.ciphertext,
        encrypted_data_key: encrypted.encryptedDataKey,
        iv: encrypted.iv,
        auth_tag: encrypted.authTag,
        algorithm: encrypted.algorithm,
        key_version: encrypted.keyVersion,
        org_id: "orgId" in scope ? scope.orgId : undefined,
        owner_id: "ownerId" in scope ? scope.ownerId : undefined,
      };

      const { data, error } = await opts.client.from("nia_secrets").insert(row).select("id").single();
      if (error || !data) {
        throw new Error(`nia_secrets write failed: ${error?.message ?? "no row returned"}`);
      }
      return (data as { id: string }).id;
    },

    async delete(ref) {
      const { error } = await opts.client.from("nia_secrets").delete().eq("id", ref);
      if (error) {
        throw new Error(`nia_secrets delete failed for ${ref}: ${error.message}`);
      }
    },
  };
}
