import { createAuth } from "@nia/auth";
import { dbPool } from "./dbPool.js";
import { env } from "../env.js";

/**
 * One Better Auth instance for the process, backed by the same pool as
 * @nia/db. This service never issues its own sessions (login/signup are
 * apps/web Server Actions) — the only method ever called on this is
 * `auth.api.getSession({ headers })`, from middleware/auth.ts and
 * middleware/cookieAuth.ts, to verify a session apps/web created.
 */
export const auth = createAuth(dbPool, {
  baseURL: env.API_URL,
  secret: env.BETTER_AUTH_SECRET,
});
