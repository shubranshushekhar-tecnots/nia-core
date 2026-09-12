import type { SupabaseClient } from "@supabase/supabase-js";
import type { UserContext } from "../lib/actorTypes.js";

declare global {
  namespace Express {
    interface Request {
      /** Per-request client scoped to the caller's access token. Set by requireAuth. */
      supabase?: SupabaseClient;
      /** Raw Supabase auth user. Set by requireAuth. */
      authUser?: { id: string; email: string };
      /** Profile + org-membership context. Set by attachActor. */
      actor?: UserContext;
    }
  }
}

export {};
