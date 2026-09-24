/**
 * Shared setup + ref-collection for the Vault -> nia_secrets backfill/verify
 * tooling (docs/plans/secret-storage.md Step 2C):
 *   scripts/secrets-backfill.ts, scripts/secrets-verify.ts,
 *   scripts/secrets-rotate.ts.
 *
 * Deliberately reads SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/
 * NIA_SECRET_MASTER_KEY straight from process.env (via dotenv/config), the
 * same convention as scripts/dispatch-smoke.ts, rather than importing
 * apps/worker/src/env.ts's full zod schema — these are standalone ops
 * tools, not the worker process, and shouldn't fail to boot over an
 * unrelated env var (e.g. OPENAI_API_KEY) these scripts never touch.
 */
import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseMasterKey } from "@nia/secrets";

export function getSupabaseServiceClient(): SupabaseClient {
  const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY must be set (apps/worker/.env or the environment).");
  }
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function getMasterKey(): Buffer {
  return parseMasterKey(process.env.NIA_SECRET_MASTER_KEY);
}

export interface SecretRefTask {
  /** The opaque ref currently stored on the referencing row — a Vault ref (pre-migration) or already a nia_secrets id. */
  ref: string;
  table: "connections" | "write_grants";
  rowId: string;
  scope: { org_id: string | null; owner_id: string | null };
}

/**
 * Every ref currently live on connections.vault_secret_ref or
 * write_grants.write_credential_vault_ref, with the org/owner scope each
 * belongs to. write_grants has no org_id/owner_id of its own (scope comes
 * from its parent connection, per 0007_connectors.sql) — resolved here via
 * connection_id rather than a PostgREST nested-embed, to keep the query
 * shape simple and predictable.
 */
export async function collectSecretRefTasks(supabase: SupabaseClient): Promise<SecretRefTask[]> {
  const tasks: SecretRefTask[] = [];

  const { data: connections, error: connErr } = await supabase
    .from("connections")
    .select("id, org_id, owner_id, vault_secret_ref");
  if (connErr) {
    throw new Error(`reading connections failed: ${connErr.message}`);
  }

  const connectionScopeById = new Map<string, { org_id: string | null; owner_id: string | null }>();
  for (const row of connections ?? []) {
    connectionScopeById.set(row.id as string, { org_id: row.org_id as string | null, owner_id: row.owner_id as string | null });
    tasks.push({
      ref: row.vault_secret_ref as string,
      table: "connections",
      rowId: row.id as string,
      scope: { org_id: row.org_id as string | null, owner_id: row.owner_id as string | null },
    });
  }

  const { data: grants, error: grantErr } = await supabase
    .from("write_grants")
    .select("id, connection_id, write_credential_vault_ref")
    .not("write_credential_vault_ref", "is", null);
  if (grantErr) {
    throw new Error(`reading write_grants failed: ${grantErr.message}`);
  }

  for (const row of grants ?? []) {
    const scope = connectionScopeById.get(row.connection_id as string);
    if (!scope) {
      // FK-enforced (write_grants.connection_id references connections.id,
      // on delete cascade) — shouldn't happen. Skip defensively rather than
      // crash the whole run over one orphaned-looking row.
      console.error(`SKIP write_grants ${row.id}: parent connection ${row.connection_id} not found.`);
      continue;
    }
    tasks.push({
      ref: row.write_credential_vault_ref as string,
      table: "write_grants",
      rowId: row.id as string,
      scope,
    });
  }

  return tasks;
}
