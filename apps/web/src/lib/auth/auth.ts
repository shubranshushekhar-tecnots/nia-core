import { createAuth, type Auth } from "@nia/auth";
import { nextCookies } from "better-auth/next-js";
import { getPool } from "@/lib/db/pool";

/**
 * apps/web's own Better Auth instance. Same pool/DB as apps/api's (see
 * apps/api/src/lib/auth.ts) — sessions created by either app are readable
 * by the other since they're plain database rows. `baseURL` here is
 * apps/web's OWN origin (not apps/api's): this instance issues/reads the
 * session cookie for apps/web's domain, since Server Actions/Route
 * Handlers here call `getAuth().api.*` directly rather than going through
 * apps/api's HTTP surface.
 *
 * `nextCookies()` must stay last in the plugins array (better-auth
 * convention) — it auto-forwards any `Set-Cookie` an `auth.api.*` call
 * produces onto the current request via `next/headers`, so callers don't
 * need to manually parse/set the cookie themselves.
 *
 * Lazy by design: createAuth() pulls in getPool() (see lib/db/pool.ts),
 * which requires DATABASE_URL. `next build`'s page-data-collection step
 * imports every route module without DATABASE_URL set, so this can't be
 * constructed at module-import time — only the first time a caller
 * actually invokes getAuth() (i.e. at request time).
 */
// Console v1 Slice 4: Auth's TExtraPlugins tuple must match the `plugins`
// array passed to createAuth() below exactly (see @nia/auth's config.ts) —
// otherwise this collapses to Auth's no-extra-plugins default and the two
// types stop being assignable to each other.
type WebAuth = Auth<[ReturnType<typeof nextCookies>]>;

let authInstance: WebAuth | undefined;

export function getAuth(): WebAuth {
  if (!authInstance) {
    authInstance = createAuth(getPool(), {
      baseURL: process.env.SITE_URL!,
      secret: process.env.BETTER_AUTH_SECRET!,
      plugins: [nextCookies()],
    });
  }
  return authInstance;
}
