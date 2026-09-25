/**
 * Shared setup for scripts/secrets-rotate.ts.
 *
 * Deliberately reads SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY straight from
 * process.env (via dotenv/config), the same convention as
 * scripts/dispatch-smoke.ts, rather than importing apps/worker/src/env.ts's
 * full zod schema — this is a standalone ops tool, not the worker process,
 * and shouldn't fail to boot over an unrelated env var (e.g. OPENAI_API_KEY)
 * it never touches.
 *
 * The Vault -> nia_secrets backfill/verify tooling this file used to also
 * back (secrets-backfill.ts, secrets-verify.ts, and their collectSecretRefTasks
 * ref-collection helper) was deleted once every live ref was confirmed
 * migrated and the Vault RPCs it depended on were dropped — see
 * docs/decisions.md's Vault-removal entry.
 */
import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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
