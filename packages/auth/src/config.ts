import { betterAuth } from "better-auth";
import { bearer, emailOTP, twoFactor } from "better-auth/plugins";
import type { BetterAuthPlugin } from "better-auth";
import type { Pool } from "pg";
import { twoFactorSession } from "./twoFactorSession.js";

/** Mirrors the emailOTP plugin's own `type` union (not re-exported by better-auth). */
export type AuthEmailType = "sign-in" | "email-verification" | "forget-password" | "change-email";

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
  /**
   * Delivers a one-time code (sign-in, email verification, or password
   * reset) by email — backs the `emailOTP` plugin below. Optional because
   * apps/api instantiates its own auth instance purely for session
   * verification and never triggers an OTP send itself; apps/web, the only
   * caller that actually invokes these endpoints, always passes this.
   * Left unset, the plugin's send still "succeeds" (no-op) rather than
   * throwing, so a misconfigured caller fails silently instead of crashing
   * a request — acceptable here since apps/api never exercises this path.
   */
  sendAuthEmail?: (data: { type: AuthEmailType; email: string; otp: string }) => Promise<void>;
  /**
   * Email Phase 3 signup gate. Backs `user.validateUserInfo` below — only
   * `apps/web`'s `getAuth()` passes this, and only unless
   * `SIGNUP_MODE === "open"` (fail-safe default: unset/misconfigured reads
   * as gated, see apps/web/src/lib/auth/auth.ts); apps/api's own instance
   * never calls `signUpEmail`, so it never passes this and the gate is a
   * no-op there regardless.
   * Returning false rejects the `create-user` call with a 403; existing
   * users signing back in never hit this (validateUserInfo only fires on
   * `create-user`/`link-account`/provider `sign-in`, not plain email/
   * password sign-in — see better-auth's ValidateUserInfoAction).
   */
  checkSignupAllowed?: (email: string) => Promise<boolean>;
  /**
   * Email Phase 3 security fix: when true, `signUpEmail` no longer
   * auto-signs-in (see sign-up.mjs's `shouldSkipAutoSignIn`) and instead
   * sends an email-verification OTP (via the `emailOTP` plugin's
   * `overrideDefaultEmailVerification` hook below, which routes it through
   * `sendAuthEmail`'s `"email-verification"` branch — already wired for
   * Email Phase 2). The caller must then complete `auth.api.verifyEmailOTP`
   * before a session is created (`emailVerification.autoSignInAfterVerification`
   * below). Without this, `checkSignupAllowed`'s email-allowlist gate
   * (above) can be satisfied by anyone who merely *knows* an approved/
   * invited email address, not just whoever owns its inbox — only
   * `apps/web`'s `getAuth()` passes this, and only unless
   * `SIGNUP_MODE === "open"` (same condition as `checkSignupAllowed`).
   */
  requireEmailVerification?: boolean;
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
      requireEmailVerification: options.requireEmailVerification ?? false,
    },
    // Only takes effect when requireEmailVerification is true (see its doc
    // comment above) — autoSignInAfterVerification lets verifyEmailOTP
    // create a real session once the OTP is confirmed, so the gated signup
    // flow still ends in "signed in", just after one extra step instead of
    // zero.
    emailVerification: {
      autoSignInAfterVerification: true,
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
    plugins: [
      bearer(),
      twoFactor({ trustDeviceMaxAge: 0 }),
      twoFactorSession(),
      // emailOTP (Email Phase 2): backs login-by-code, email verification,
      // and password reset-by-code. One shared `expiresIn` for all three
      // types (better-auth has no per-type override) — 10 min, a reasonable
      // middle ground between the login-code and reset-code use cases.
      // `overrideDefaultEmailVerification: true` makes better-auth's own
      // built-in (link-based) verification email send an OTP through this
      // plugin instead — we only want one verification mechanism active.
      // `emailAndPassword.requireEmailVerification` is `false` by default
      // (verification is informational, never blocks sign-in) — apps/web
      // flips it to `true` unless SIGNUP_MODE=open (see
      // requireEmailVerification's doc comment above), so the allowlist
      // gate can't be satisfied by someone who doesn't own the email.
      //
      // `disableSignUp: true` — without this, better-auth's own
      // signInEmailOTP route silently creates a brand-new account for any
      // email that completes the sign-in OTP flow, even one that never
      // signed up (see better-auth/dist/plugins/email-otp/routes.mjs's
      // signInEmailOTP handler: `if (!user) { if (opts.disableSignUp)
      // throw ...; else createUser(...) }`). "Email me a code" is meant to
      // be an alternate login method for existing accounts only, never a
      // backdoor signup flow — set this or anyone can create an account
      // just by entering an email and the code that gets sent to it.
      emailOTP({
        otpLength: 6,
        expiresIn: 600,
        allowedAttempts: 3,
        sendVerificationOnSignUp: true,
        overrideDefaultEmailVerification: true,
        disableSignUp: true,
        async sendVerificationOTP({ email, otp, type }) {
          await options.sendAuthEmail?.({ type, email, otp });
        },
      }),
      ...(options.plugins ?? ([] as const)),
    ],
    // Email Phase 3 signup gate. `validateUserInfo` fires on every
    // `create-user` call across every auth method (direct HTTP hit to
    // better-auth's own /sign-up/email included, not just apps/web's
    // signup() Server Action), and is NOT re-invoked for a returning
    // email/password sign-in — so existing users/staff are structurally
    // unaffected regardless of what checkSignupAllowed returns. Only
    // gates `action === "create-user"`: `link-account`/`sign-in` cover
    // OAuth/SSO flows this app doesn't use, and gating them too would
    // just be dead code.
    user: {
      validateUserInfo: async ({ user, source }) => {
        if (source.action !== "create-user") return;
        if (!options.checkSignupAllowed) return;
        const email = typeof user.email === "string" ? user.email : undefined;
        if (!email) return;
        const allowed = await options.checkSignupAllowed(email);
        if (!allowed) {
          return {
            error: "signup_not_allowed",
            errorDescription: "This email hasn't been approved for access yet.",
          };
        }
      },
    },
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

            // Email Phase 3: apply the plan/grant staff chose at
            // approval/invite time, if any. 0051_owner_plan_table.sql's
            // `set_default_owner_plan_trigger` (AFTER INSERT on
            // public."user") has already inserted a 'free' owner_plan row
            // by now — it fires synchronously as part of the very INSERT
            // that created `user`, which runs (and commits its effects
            // within the same statement) before better-auth hands control
            // back to this `after` callback. So this is an UPDATE, not an
            // insert — same upsert target as apps/api/src/routes/
            // console.ts's `PATCH /console/users/:userId/plan`, just
            // reached through a different trigger. Platform invites are
            // checked first: a staff-initiated direct invite is a
            // stronger signal than a self-submitted request, and in
            // practice the two should never both match the same email.
            const inviteResult = await pool.query<{
              id: string;
              plan_id: string | null;
              grant_plan_id: string | null;
              grant_expires_at: string | null;
            }>(
              `select id, plan_id, grant_plan_id, grant_expires_at
               from public.platform_invites
               where lower(email) = lower($1) and status in ('pending', 'accepted')
               order by created_at desc
               limit 1`,
              [user.email],
            );
            const match = inviteResult.rows[0];
            const requestResult = match
              ? null
              : await pool.query<{
                  id: string;
                  plan_id: string | null;
                  grant_plan_id: string | null;
                  grant_expires_at: string | null;
                }>(
                  `select id, plan_id, grant_plan_id, grant_expires_at
                   from public.access_requests
                   where lower(email) = lower($1) and status = 'approved'
                   limit 1`,
                  [user.email],
                );
            const applied = match ?? requestResult?.rows[0];

            if (applied) {
              // coalesce: a null plan_id on the matched row means "leave
              // the signup default (free) alone", not "clear the plan".
              await pool.query(
                `update public.owner_plan
                   set plan_id = coalesce($2, plan_id),
                       grant_plan_id = $3,
                       grant_expires_at = $4,
                       updated_at = now()
                 where user_id = $1`,
                [user.id, applied.plan_id, applied.grant_plan_id, applied.grant_expires_at],
              );
            }
            if (requestResult?.rows[0]) {
              await pool.query(
                `update public.access_requests set signed_up_user_id = $2 where id = $1`,
                [requestResult.rows[0].id, user.id],
              );
            }
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
