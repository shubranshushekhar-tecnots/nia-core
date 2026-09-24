import type { SupabaseClient } from "@supabase/supabase-js";
import type { UserContext } from "../lib/actorTypes.js";
import type { WithUser } from "../lib/withUser.js";

declare global {
  namespace Express {
    interface Request {
      /**
       * Per-request client scoped to the caller's access token. Set by
       * requireAuth. Still used for Supabase Auth calls (supabase.auth.*)
       * and by any not-yet-converted service (docs/plans/data-access.md,
       * Step 3) — data access itself is migrating to req.withUser below.
       */
      supabase?: SupabaseClient;
      /** Raw Supabase auth user. Set by requireAuth. */
      authUser?: { id: string; email: string };
      /** Runs a query/transaction as the caller via @nia/db. Set by attachDb. See lib/withUser.ts. */
      withUser?: WithUser;
      /** Profile + org-membership context. Set by attachActor. */
      actor?: UserContext;
    }
  }
}

export {};
