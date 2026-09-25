import { CURRENT_KEY_VERSION, decryptSecret, encryptSecret, parseMasterKey, type EncryptedSecret, type SecretScope, type SecretStore } from "@nia/secrets";
import { withServiceRole } from "@nia/db";
import type pg from "pg";
import { env } from "../env.js";

export type { SecretStore } from "@nia/secrets";

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
 * apps/worker's own SecretStore implementation, direct SQL against
 * nia_secrets via withServiceRole (RLS-bypassed — the worker has no live
 * user JWT, same reasoning as dbPool.ts/client.ts elsewhere). Mirrors
 * apps/api/src/lib/secretStore.ts's shape exactly, swapping withUser for
 * withServiceRole; no legacy Vault fallback, since the worker's only
 * secret-writing call site (lib/eval/sandbox.ts) is brand new and never
 * had a Vault-era ref to read back.
 *
 * The worker previously never held NIA_SECRET_MASTER_KEY (see
 * DEPLOYMENT.md: "not worker, which never decrypts a secret itself — it
 * only forwards an opaque ref"). That's still true for read/dispatch, but
 * writing a real nia_secrets row here means the ciphertext must be
 * decryptable by whichever connector service resolves it later, so this
 * one write path needs the same shared master key as api/connector-*.
 */
export function getSecretStore(dbPool: pg.Pool): SecretStore {
  const masterKey = parseMasterKey(env.NIA_SECRET_MASTER_KEY);

  return {
    async get(ref) {
      const { rows } = await withServiceRole(dbPool, (db) =>
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

    async put(secret, scope: SecretScope) {
      const encrypted = encryptSecret(masterKey, CURRENT_KEY_VERSION, secret);
      const orgId = "orgId" in scope ? scope.orgId : null;
      const ownerId = "ownerId" in scope ? scope.ownerId : null;
      try {
        const { rows } = await withServiceRole(dbPool, (db) =>
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
        await withServiceRole(dbPool, (db) => db.query(`delete from nia_secrets where id = $1`, [ref]));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`nia_secrets delete failed for ${ref}: ${message}`);
      }
    },
  };
}
