import { createAuth } from "@nia/auth";
import { nextCookies } from "better-auth/next-js";
import { dbPool } from "@/lib/db/pool";

/**
 * apps/web's own Better Auth instance. Same pool/DB as apps/api's (see
 * apps/api/src/lib/auth.ts) — sessions created by either app are readable
 * by the other since they're plain database rows. `baseURL` here is
 * apps/web's OWN origin (not apps/api's): this instance issues/reads the
 * session cookie for apps/web's domain, since Server Actions/Route
 * Handlers here call `auth.api.*` directly rather than going through
 * apps/api's HTTP surface.
 *
 * `nextCookies()` must stay last in the plugins array (better-auth
 * convention) — it auto-forwards any `Set-Cookie` an `auth.api.*` call
 * produces onto the current request via `next/headers`, so callers don't
 * need to manually parse/set the cookie themselves.
 */
export const auth = createAuth(dbPool, {
  baseURL: process.env.NEXT_PUBLIC_SITE_URL!,
  secret: process.env.BETTER_AUTH_SECRET!,
  plugins: [nextCookies()],
});
