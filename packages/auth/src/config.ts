import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import type { BetterAuthPlugin } from "better-auth";
import type { Pool } from "pg";

// Rolling session: a session is valid for 30 days from last use, and its
// expiry is pushed forward once a day it's used. This mirrors the old
// GoTrue behavior of silently refreshing the access token on every request
// while the refresh token was valid, without requiring the client to do
// anything special.
const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30; // 30 days
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24; // refresh at most once/day

export interface CreateAuthOptions {
  /** Public base URL of the app instantiating this auth instance. */
  baseURL: string;
  /** Value of BETTER_AUTH_SECRET (or equivalent) for this environment. */
  secret: string;
  /**
   * Extra plugins appended after `bearer()`. apps/web uses this to add
   * `nextCookies()` (from `better-auth/next-js`) so that `Set-Cookie`
   * headers from direct `auth.api.*` calls in Server Actions/Route
   * Handlers get forwarded automatically via `next/headers`. apps/api has
   * no Next.js request context, so it never passes this. Per better-auth
   * convention, a caller passing `nextCookies()` must put it last in its
   * own array — this function appends `extraPlugins` after `bearer()`
   * unconditionally, so callers just need to order their own array
   * correctly (irrelevant here since only one extra plugin is used today).
   */
  plugins?: BetterAuthPlugin[];
}

/**
 * Builds a Better Auth instance backed directly by a `pg.Pool`.
 *
 * Both apps/api and apps/web instantiate their own copy of this against
 * their own pool, all pointed at the same Postgres database and the same
 * `user`/`session`/`account`/`verification` tables — sessions created by
 * one app are readable by the other since they're plain database rows,
 * not in-memory or signed-JWT state.
 */
export function createAuth(pool: Pool, options: CreateAuthOptions) {
  return betterAuth({
    database: pool,
    baseURL: options.baseURL,
    secret: options.secret,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      autoSignIn: true,
    },
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    },
    advanced: {
      // Emits crypto.randomUUID() for every table's id column, matching
      // the uuid columns the migration creates and letting existing
      // app tables' FKs point straight at user.id.
      database: { generateId: "uuid" },
    },
    // Lets a session created via the Set-Cookie flow also be presented as
    // `Authorization: Bearer <token>` — this is what apps/web uses when
    // calling apps/api from Server Components/Actions, and what apps/api's
    // Bearer middleware verifies. Cookie-forwarding routes (chat/runs/
    // copilot-agent) keep working unchanged since bearer() only adds a
    // header-based path, it doesn't remove the cookie one.
    plugins: [bearer(), ...(options.plugins ?? [])],
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            // Replaces the old `handle_new_user` trigger on auth.users.
            // Runs on the same pool (postgres role), so it bypasses RLS
            // exactly like the trigger did.
            await pool.query(
              `insert into public.profiles (id, email, full_name)
               values ($1, $2, $3)
               on conflict (id) do nothing`,
              [user.id, user.email, user.name ?? null],
            );
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
