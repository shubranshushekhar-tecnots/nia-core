import type { SupabaseClient } from "@supabase/supabase-js";
import { createEnvKeySecretStore, type SecretScope, type SecretStore } from "@nia/secrets";
import type { WorkspaceScope } from "./workspaceScope.js";
import { env } from "../env.js";

export type { SecretStore } from "@nia/secrets";

/** apps/api's WorkspaceScope and @nia/secrets's SecretScope are the same shape by convention — this is the one place that assumes it. */
export function toSecretScope(scope: WorkspaceScope): SecretScope {
  return "orgId" in scope ? { orgId: scope.orgId } : { ownerId: scope.ownerId };
}

/**
 * apps/api holds no service_role key (env.ts's header comment), so it can
 * never call resolve_connector_secret directly to decrypt a ref that
 * predates nia_secrets. decrypt_connector_secret_for_edit (0032) is the
 * narrow, authenticated-callable equivalent — see
 * docs/plans/secret-storage.md's update-path report for why this is the
 * only new RPC the migration off Vault needed.
 */
export function getSecretStore(supabase: SupabaseClient): SecretStore {
  return createEnvKeySecretStore({
    client: supabase,
    masterKey: env.NIA_SECRET_MASTER_KEY,
    legacyResolve: async (ref) => {
      const { data, error } = await supabase.rpc("decrypt_connector_secret_for_edit", { p_ref: ref });
      if (error) throw new Error(`decrypt_connector_secret_for_edit failed for ${ref}: ${error.message}`);
      return (data as Record<string, unknown> | null) ?? null;
    },
  });
}
