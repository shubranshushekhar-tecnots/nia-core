import { createAuth, type Auth, type AuthEmailType } from "@nia/auth";
import { nextCookies } from "better-auth/next-js";
import { getPool } from "@/lib/db/pool";
import { enqueueEmail } from "@/lib/mail/mailQueue";
import { checkSignupAllowed } from "@/lib/auth/signupGate";

// Shared with @nia/auth's config.ts: the emailOTP plugin is configured with
// one `expiresIn: 600` for every OTP type (sign-in, email-verification,
// forget-password) — kept here only to render "expires in N minutes" copy
// in the email itself; changing one without the other will just make the
// copy wrong, not the actual expiry.
const OTP_EXPIRES_IN_MINUTES = 10;

/**
 * Maps a better-auth emailOTP `type` to one of @nia/mail's branded
 * templates and enqueues it. "change-email" has no template yet (Phase 2
 * doesn't wire up email-change) — silently no-ops rather than throwing, so
 * better-auth's own call site never fails a request over it.
 */
async function sendAuthEmail(data: { type: AuthEmailType; email: string; otp: string }): Promise<void> {
  const { type, email, otp } = data;
  if (type === "sign-in") {
    await enqueueEmail({
      kind: "send_email",
      to: email,
      payload: { template: "loginCode", data: { code: otp, expiresInMinutes: OTP_EXPIRES_IN_MINUTES } },
    });
  } else if (type === "email-verification") {
    await enqueueEmail({
      kind: "send_email",
      to: email,
      payload: { template: "verifyEmail", data: { code: otp, expiresInMinutes: OTP_EXPIRES_IN_MINUTES } },
    });
  } else if (type === "forget-password") {
    const resetUrl = `${process.env.SITE_URL}/reset-password?email=${encodeURIComponent(email)}&otp=${encodeURIComponent(otp)}`;
    await enqueueEmail({
      kind: "send_email",
      to: email,
      payload: {
        template: "passwordReset",
        data: { code: otp, expiresInMinutes: OTP_EXPIRES_IN_MINUTES, resetUrl },
      },
    });
  }
  // "change-email": no-op, not wired up in Phase 2.
}

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
      sendAuthEmail,
      // Email Phase 3: gate signups unless SIGNUP_MODE is explicitly "open" —
      // fail-safe default. An unset/misconfigured env var must never silently
      // fall open in production; "open" is an opt-in escape hatch, not the
      // absence of a value. Left undefined (not a function returning true)
      // only in that explicit "open" case so createAuth's validateUserInfo
      // hook is a no-op — see @nia/auth's config.ts for why that's safe for
      // existing-user sign-in.
      checkSignupAllowed: process.env.SIGNUP_MODE === "open" ? undefined : checkSignupAllowed,
      // Email Phase 3 security fix: same fail-safe condition as
      // checkSignupAllowed — without this, the email-allowlist gate above
      // could be satisfied by anyone who merely knows an approved/invited
      // email address, not just whoever owns its inbox. See @nia/auth's
      // config.ts for the mechanism.
      requireEmailVerification: process.env.SIGNUP_MODE !== "open",
    });
  }
  return authInstance;
}
