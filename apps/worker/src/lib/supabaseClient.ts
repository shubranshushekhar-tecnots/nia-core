import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../env.js";

/**
 * The worker's one Supabase client — service_role, module-level (not
 * per-request; the worker never holds a live user JWT — see
 * apps/worker/src/index.ts's header comment and the workflow_runs
 * precedent it documents).
 *
 * *** THIS CLIENT BYPASSES ROW LEVEL SECURITY ENTIRELY. ***
 * RLS is the app's sole authorization boundary everywhere else (root
 * CONVENTIONS.md) — it does not apply to service_role. Any code that reads a
 * row through this client and then acts on it MUST independently
 * re-derive and check the caller's own scope (org_id/owner_id) in
 * application code before trusting that row belongs to the right
 * workspace. resolveConnection.ts is the first such call site: it takes a
 * mandatory WorkspaceScope and treats "row exists but belongs to a
 * different org/owner" identically to "row doesn't exist" — never assume
 * a row this client returns was already scoped correctly.
 */
export const supabase: SupabaseClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
