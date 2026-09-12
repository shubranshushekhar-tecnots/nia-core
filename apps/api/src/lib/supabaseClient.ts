import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../env.js";

/**
 * One client per request, scoped to the caller's own access token so every
 * PostgREST call this client makes carries their JWT and Postgres RLS sees
 * the real auth.uid() — the exact same trust boundary the Next.js BFF had
 * via createServerClient() + cookies, just keyed by a Bearer token instead.
 *
 * Never construct a shared/module-level client with a real user's token —
 * see req.supabase in middleware/auth.ts for the only place this should be
 * called from.
 */
export function createRequestSupabaseClient(accessToken: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
