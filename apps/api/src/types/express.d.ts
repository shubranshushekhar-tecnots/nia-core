import type { UserContext } from "../lib/actorTypes.js";
import type { WithUser } from "../lib/withUser.js";

declare global {
  namespace Express {
    interface Request {
      /** Better Auth session user. Set by requireAuth / requireCookieAuth. */
      authUser?: { id: string; email: string };
      /** Runs a query/transaction as the caller via @nia/db. Set by attachDb. See lib/withUser.ts. */
      withUser?: WithUser;
      /** Profile + org-membership context. Set by attachActor. */
      actor?: UserContext;
    }
  }
}

export {};
