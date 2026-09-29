import { betterAuth } from "better-auth";
import { bearer, twoFactor } from "better-auth/plugins";
import type { BetterAuthPlugin } from "better-auth";
import type { Pool } from "pg";
import { twoFactorSession } from "./twoFactorSession.js";

// Rolling session: a session is valid for 30 days from last use, and its
// expiry is pushed forward once a day it's used. This mirrors the old
// GoTrue behavior of silently refreshing the access token on every request
// while the refresh token was valid, without requiring the client to do
// anything special.
const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30; // 30 days
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24; // refresh at most once/day

export interface CreateAuthOptions<TExtraPlugins extends readonly BetterAuthPlugin[] = readonly BetterAuthPlugin[]> {
  /** Public base URL of the app instantiating this auth instance. */
  baseURL: string;
  /** Value of BETTER_AUTH_SECRET (or equivalent) for this environment. */
  secret: string;
  /**
   * Extra plugins appended after `bearer()`/`twoFactor()`/`twoFactorSession()`.
   * apps/web uses this to add `nextCookies()` (from `better-auth/next-js`) so
   * that `Set-Cookie` headers from direct `auth.api.*` calls in Server
   * Actions/Route Handlers get forwarded automatically via `next/headers`.
   * apps/api has no Next.js request context, so it never passes this. Per
   * better-auth convention, a caller passing `nextCookies()` must put it
   * last in its own array — this function appends `extraPlugins` after its
   * own fixed plugins unconditionally, so callers just need to order their
   * own array correctly (irrelevant here since only one extra plugin is
   * used today).
   *
   * Typed as a `const` generic tuple (not plain `BetterAuthPlugin[]`) so
   * `createAuth`'s plugins array stays a tuple all the way into
   * `betterAuth()` — spreading a widened `BetterAuthPlugin[]` into that
   * array literal would collapse the WHOLE literal (including bearer()/
   * twoFactor()/twoFactorSession()) to a plain array, which is enough for
   * betterAuth to lose each plugin's specific endpoint types (e.g.
   * `auth.api.verifyTOTP`) even though core methods like `signInEmail`
   * keep working either way.
   */
  plugins?: TExtraPlugins;
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
export function createAuth<const TExtraPlugins extends readonly BetterAuthPlugin[] = []>(
  pool: Pool,
  options: CreateAuthOptions<TExtraPlugins>,
) {
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
    //
    // twoFactor({trustDeviceMaxAge: 0}) (Console v1 Slice 4,
    // console-plan.md §4b): enables TOTP + backup-code 2FA for every user
    // (only staff are ever required to complete it — requireStaff gates on
    // it, nothing else in the app does). trustDeviceMaxAge: 0 disables the
    // plugin's own "remember this device" cookie, which would otherwise let
    // a session skip the challenge entirely on a return visit — staff must
    // re-verify every time their session is old enough to need it,
    // regardless of device history. twoFactorSession() is this project's
    // own plugin (see twoFactorSession.ts) that stamps
    // session.twoFactorVerifiedAt on a successful verify.
    plugins: [bearer(), twoFactor({ trustDeviceMaxAge: 0 }), twoFactorSession(), ...(options.plugins ?? ([] as const))],
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

// Generic over the same `TExtraPlugins` tuple as createAuth() — a caller
// passing extra plugins (apps/web's nextCookies()) must supply the matching
// tuple type argument here too, or this collapses to the no-extra-plugins
// default and mismatches the actual instance's type (see createAuth's
// TExtraPlugins doc comment for why the tuple has to match exactly).
export type Auth<TExtraPlugins extends readonly BetterAuthPlugin[] = []> = ReturnType<
  typeof createAuth<TExtraPlugins>
>;
