import { withServiceRole } from "@nia/db";
import type pg from "pg";
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

type NiaSecretRow = {
  id: string;
  ciphertext: string;
  encrypted_data_key: string;
  iv: string;
  auth_tag: string;
  algorithm: string;
  key_version: number;
};

/**
 * Bumped only when a full re-encryption/rotation format changes — see
 * rotation TODO. Exported so one-off tooling that writes nia_secrets rows
 * outside of a SecretStore instance (apps/worker/scripts/secrets-backfill.ts)
 * can't drift from the value real traffic uses.
 */
export const CURRENT_KEY_VERSION = 1;

export interface CreateEnvKeySecretStoreOptions {
  /** A pg.Pool for the app database; nia_secrets RLS is bypassed via withServiceRole (SET LOCAL ROLE service_role), same pattern as apps/api and apps/worker's own SecretStore implementations. */
  pool: pg.Pool;
  /** Raw NIA_SECRET_MASTER_KEY value; validated eagerly so a malformed key fails fast at store-construction time. */
  masterKey: string;
}

/** The env-key SecretStore implementation: NIA_SECRET_MASTER_KEY from process env, backed by the nia_secrets table. */
export function createEnvKeySecretStore(opts: CreateEnvKeySecretStoreOptions): SecretStore {
  const masterKey = parseMasterKey(opts.masterKey);

  return {
    async get(ref) {
      const { rows } = await withServiceRole(opts.pool, (db) =>
        db.query<NiaSecretRow>(
          `select id, ciphertext, encrypted_data_key, iv, auth_tag, algorithm, key_version from nia_secrets where id = $1`,
          [ref],
        ),
      );
      const row = rows[0];
      if (!row) return null;

      const encrypted: EncryptedSecret = {
        ciphertext: row.ciphertext,
        encryptedDataKey: row.encrypted_data_key,
        iv: row.iv,
        authTag: row.auth_tag,
        algorithm: row.algorithm,
        keyVersion: row.key_version,
      };
      return decryptSecret(masterKey, encrypted);
    },

    async put(secret, scope) {
      const encrypted = encryptSecret(masterKey, CURRENT_KEY_VERSION, secret);
      const orgId = "orgId" in scope ? scope.orgId : null;
      const ownerId = "ownerId" in scope ? scope.ownerId : null;
      try {
        const { rows } = await withServiceRole(opts.pool, (db) =>
          db.query<{ id: string }>(
            `insert into nia_secrets (ciphertext, encrypted_data_key, iv, auth_tag, algorithm, key_version, org_id, owner_id)
             values ($1, $2, $3, $4, $5, $6, $7, $8)
             returning id`,
            [
              encrypted.ciphertext,
              encrypted.encryptedDataKey,
              encrypted.iv,
              encrypted.authTag,
              encrypted.algorithm,
              encrypted.keyVersion,
              orgId,
              ownerId,
            ],
          ),
        );
        const row = rows[0];
        if (!row) throw new Error("no row returned");
        return row.id;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`nia_secrets write failed: ${message}`);
      }
    },

    async delete(ref) {
      try {
        await withServiceRole(opts.pool, (db) => db.query(`delete from nia_secrets where id = $1`, [ref]));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`nia_secrets delete failed for ${ref}: ${message}`);
      }
    },
  };
}
