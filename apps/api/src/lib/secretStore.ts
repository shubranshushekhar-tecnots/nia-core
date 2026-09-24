import { CURRENT_KEY_VERSION, decryptSecret, encryptSecret, parseMasterKey, type EncryptedSecret, type SecretScope, type SecretStore } from "@nia/secrets";
import type { WorkspaceScope } from "./workspaceScope.js";
import type { WithUser } from "./withUser.js";
import { env } from "../env.js";

export type { SecretStore } from "@nia/secrets";

/** apps/api's WorkspaceScope and @nia/secrets's SecretScope are the same shape by convention — this is the one place that assumes it. */
export function toSecretScope(scope: WorkspaceScope): SecretScope {
  return "orgId" in scope ? { orgId: scope.orgId } : { ownerId: scope.ownerId };
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
 * apps/api's own SecretStore implementation, direct SQL against nia_secrets
 * via the caller's own withUser (RLS-scoped, same as every other table this
 * app touches — see 0032_nia_secrets.sql's grant to `authenticated`). Kept
 * separate from @nia/secrets's createEnvKeySecretStore (still SupabaseClient-
 * typed) because that factory is also used by apps/worker's backfill/verify
 * scripts and the connector services under a service-role client — this app
 * has no service-role key (env.ts's header comment) and never will, so its
 * own implementation only ever needs the authenticated-role path.
 *
 * apps/api holds no service_role key, so it can never call
 * resolve_connector_secret (0008, service_role-only) directly to decrypt a
 * ref that predates nia_secrets. decrypt_connector_secret_for_edit (0032) is
 * the narrow, authenticated-callable equivalent — see
 * docs/plans/secret-storage.md's update-path report for why this is the
 * only new RPC the migration off Vault needed.
 */
export function getSecretStore(withUser: WithUser): SecretStore {
  const masterKey = parseMasterKey(env.NIA_SECRET_MASTER_KEY);

  return {
    async get(ref) {
      const { rows } = await withUser((db) =>
        db.query<NiaSecretRow>(
          `select id, ciphertext, encrypted_data_key, iv, auth_tag, algorithm, key_version from nia_secrets where id = $1`,
          [ref],
        ),
      );
      const row = rows[0];
      if (row) {
        const encrypted: EncryptedSecret = {
          ciphertext: row.ciphertext,
          encryptedDataKey: row.encrypted_data_key,
          iv: row.iv,
          authTag: row.auth_tag,
          algorithm: row.algorithm,
          keyVersion: row.key_version,
        };
        return decryptSecret(masterKey, encrypted);
      }

      try {
        const { rows: legacyRows } = await withUser((db) =>
          db.query<{ decrypt_connector_secret_for_edit: Record<string, unknown> | null }>(
            `select public.decrypt_connector_secret_for_edit($1)`,
            [ref],
          ),
        );
        return legacyRows[0]?.decrypt_connector_secret_for_edit ?? null;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`decrypt_connector_secret_for_edit failed for ${ref}: ${message}`);
      }
    },

    async put(secret, scope) {
      const encrypted = encryptSecret(masterKey, CURRENT_KEY_VERSION, secret);
      const orgId = "orgId" in scope ? scope.orgId : null;
      const ownerId = "ownerId" in scope ? scope.ownerId : null;
      try {
        const { rows } = await withUser((db) =>
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
        await withUser((db) => db.query(`delete from nia_secrets where id = $1`, [ref]));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`nia_secrets delete failed for ${ref}: ${message}`);
      }
    },
  };
}
