"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers, cookies } from "next/headers";
import { z } from "zod";
import { APIError } from "better-auth/api";
import { withActingUser } from "@nia/db";
import { getAuth } from "@/lib/auth/auth";
import { ACTIVE_ORG_COOKIE, getSessionUser } from "@/lib/auth/session";
import { getPool } from "@/lib/db/pool";
import { enqueueEmail } from "@/lib/mail/mailQueue";
import { isAuthActionRateLimited } from "@/lib/auth/rateLimit";
import { allowSignupOnce, isOrgInviteTokenValid, peekPlatformInviteEmail } from "@/lib/auth/signupGate";

export type ActionState = {
  error?: string;
  // Item 5 (fix-chain plan): raw driver/connector text behind a "Show
  // details" toggle, set alongside a friendlier `error` summary by actions
  // that surface connector test/refresh errors (see connections/actions.ts's
  // friendlyApiErrorMessage). Additive/optional so auth actions (which never
  // set it) are unaffected.
  errorDetails?: string;
  // Learning-mode plan, Layer 3: the concrete "how to fix this" line from
  // `friendlyAppError`/`friendlyConnectionError` (packages/schemas), shown
  // under `error` and above the "Show details" toggle. `helpStepKey` rides
  // along for Step 3/4's HelpPanel to key off of — not rendered as a link
  // yet, just carried through so wiring it later doesn't need another pass
  // over every action/dialog. Both additive/optional, same as errorDetails.
  errorFix?: string;
  helpStepKey?: string;
  fieldErrors?: Record<string, string[]>;
  success?: boolean;
  // Set by login/signup only: the raw session token (docs/plans/auth.md) —
  // Better Auth's session cookie is httpOnly, so the client can't read it
  // itself. LoginForm/SignupForm store this via lib/auth/browserSession.ts
  // then navigate to `next`, instead of the Server Action redirecting
  // directly — the cookie is already set by then (nextCookies() plugin,
  // lib/auth/auth.ts), this is purely for the Bearer-token client
  // fetches (lib/api/*Client.ts).
  token?: string;
  next?: string;
  // Console v1 Slice 4 (docs/plans/console-plan.md §4b): set by login() when
  // packages/auth's twoFactor() plugin short-circuits sign-in with a 2FA
  // challenge instead of a session, and re-set by verifyTwoFactor() on a
  // failed attempt so the code-entry step stays up (rather than bouncing
  // back to the email/password step) until the user gets it right.
  twoFactorRequired?: boolean;
  // Email Phase 2: info-only text (not an error) shown after
  // requestLoginCode/requestPasswordReset — always the same generic
  // wording regardless of whether the email actually exists (see each
  // action's own comment for the no-enumeration rationale).
  message?: string;
  // Email Phase 3 security fix: set by signup() when SIGNUP_MODE=request
  // (requireEmailVerification, packages/auth/src/config.ts) instead of a
  // token — the account exists but is unverified, and SignupForm must show
  // the "enter the code we emailed you" step before a session exists.
  // `email` carries the submitted address into that step's hidden field
  // (verifySignupEmail needs it; better-auth's OTP lookup is keyed by it,
  // not by any session, since none exists yet).
  emailVerificationRequired?: boolean;
  email?: string;
} | null;

const GENERIC_CODE_SENT_MESSAGE = "If an account exists for that email, a code is on its way.";
const INVALID_CODE_MESSAGE = "That code is invalid or has expired.";
const PASSWORD_CHANGED_MESSAGE = "Password changed. Please sign in.";

// Email Phase 2 review fix: per-email/per-IP ceilings on the OTP
// request/verify Server Actions (lib/auth/rateLimit.ts). "Request" limits
// bound how many codes can be sent out; "verify" limits bound how many
// separate codes/guesses can be tried, on top of better-auth's own
// per-code `allowedAttempts: 3` (packages/auth/src/config.ts).
const OTP_REQUEST_LIMIT = 5;
const OTP_VERIFY_LIMIT = 8;

function safeNext(next: FormDataEntryValue | null): string {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/app";
}

const loginSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

export async function login(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  let token: string;
  try {
    const requestHeaders = await headers();
    const result = await getAuth().api.signInEmail({ body: parsed.data, headers: requestHeaders });
    // Console v1 Slice 4: when the user has 2FA enabled, twoFactor()'s
    // hooks.after on /sign-in/email (packages/auth/src/config.ts) replaces
    // the normal session response with `{twoFactorRedirect, twoFactorMethods}`
    // — no `token` — and sets a short-lived signed 2FA challenge cookie
    // (forwarded to the browser by nextCookies()) that verifyTwoFactor()
    // below reads on the next submit. better-auth's own signInEmail type
    // doesn't include this union (the hook's response isn't reflected in
    // its static return type), so this has to be a runtime check.
    if ("twoFactorRedirect" in result && result.twoFactorRedirect) {
      return { twoFactorRequired: true, next: safeNext(formData.get("next")) };
    }
    token = result.token;
  } catch (err) {
    if (err instanceof APIError) {
      // Deliberately vague: never reveal whether the account exists.
      return { error: "Invalid email or password." };
    }
    throw err;
  }

  revalidatePath("/", "layout");
  return { success: true, token, next: safeNext(formData.get("next")) };
}

const twoFactorSchema = z.object({
  code: z.string().min(1, "Enter your verification code"),
  method: z.enum(["totp", "backup"]).default("totp"),
});

export async function verifyTwoFactor(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = twoFactorSchema.safeParse({
    code: formData.get("code"),
    method: formData.get("method") || "totp",
  });
  if (!parsed.success) {
    return { twoFactorRequired: true, fieldErrors: parsed.error.flatten().fieldErrors, next: safeNext(formData.get("next")) };
  }

  let token: string;
  try {
    const requestHeaders = await headers();
    // verifyTOTP/verifyBackupCode read the signed 2FA cookie set by
    // login()'s signInEmail call (see comment above) to identify which
    // pending challenge this code answers — no explicit session/user id is
    // passed, it comes entirely from that cookie via `headers`.
    const result =
      parsed.data.method === "backup"
        ? await getAuth().api.verifyBackupCode({ body: { code: parsed.data.code }, headers: requestHeaders })
        : await getAuth().api.verifyTOTP({ body: { code: parsed.data.code }, headers: requestHeaders });
    if (!result.token) return { twoFactorRequired: true, error: "Something went wrong. Try again." };
    token = result.token;
  } catch (err) {
    if (err instanceof APIError) {
      // INVALID_TWO_FACTOR_COOKIE means the 5-minute challenge window
      // expired (or was never valid) — send the user back to the
      // email/password step (twoFactorRequired omitted) instead of leaving
      // them stuck re-entering codes against a challenge that no longer
      // exists.
      if (err.body?.code === "INVALID_TWO_FACTOR_COOKIE") {
        return { error: "That took too long — sign in again." };
      }
      return { twoFactorRequired: true, error: err.message || "Invalid code. Try again." };
    }
    throw err;
  }

  revalidatePath("/", "layout");
  return { success: true, token, next: safeNext(formData.get("next")) };
}

const signupSchema = z.object({
  fullName: z.string().min(1, "Name is required"),
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

/**
 * Email Phase 3 bridge: better-auth's validateUserInfo hook (the signup
 * gate, see packages/auth/src/config.ts) only ever sees `{user}` — not the
 * `next` form field carried from /login's "Create an account" link — so an
 * org-invite or platform-invite signup can't be recognized there directly.
 * This reads `next` (already same-origin-validated by safeNext's caller)
 * and, if it points at an invite accept URL with a still-valid token,
 * read-only-validates that token and sets the one-time signup-allow flag
 * (signupGate.ts) immediately before signUpEmail is called below — closing
 * enough of a race window that the flag is consumed within the same
 * request it's set in.
 *
 * Returns a field error (rather than silently falling through to the
 * gate's generic rejection) only for the platform-invite email-mismatch
 * case, since that's actionable feedback the other paths don't have an
 * equivalent for.
 */
async function bridgeInviteSignup(
  next: string,
  email: string,
): Promise<{ fieldErrors: Record<string, string[]> } | undefined> {
  const orgInviteMatch = next.match(/^\/invite\/([^/?]+)/);
  if (orgInviteMatch) {
    if (await isOrgInviteTokenValid(orgInviteMatch[1]!)) {
      await allowSignupOnce(email);
    }
    return undefined;
  }

  const platformInviteMatch = next.match(/^\/accept-invite\/([^/?]+)/);
  if (platformInviteMatch) {
    const inviteEmail = await peekPlatformInviteEmail(platformInviteMatch[1]!);
    if (inviteEmail && inviteEmail !== email.toLowerCase()) {
      return { fieldErrors: { email: ["This invite is for a different email address."] } };
    }
    if (inviteEmail) {
      await allowSignupOnce(email);
    }
    return undefined;
  }

  return undefined;
}

export async function signup(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = signupSchema.safeParse({
    fullName: formData.get("fullName"),
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const next = safeNext(formData.get("next"));
  const bridgeError = await bridgeInviteSignup(next, parsed.data.email);
  if (bridgeError) return bridgeError;

  let token: string | null;
  try {
    const requestHeaders = await headers();
    const result = await getAuth().api.signUpEmail({
      body: { email: parsed.data.email, password: parsed.data.password, name: parsed.data.fullName },
      headers: requestHeaders,
    });
    // Email Phase 3 security fix: autoSignIn (packages/auth/src/config.ts)
    // means this is only null when requireEmailVerification is active
    // (SIGNUP_MODE=request) — the allowlist gate alone can't prove the
    // submitter owns the email, so better-auth withholds the session until
    // verifySignupEmail() below confirms the OTP sent to it.
    token = result.token;
  } catch (err) {
    if (err instanceof APIError) {
      return { error: err.message || "Something went wrong. Try again." };
    }
    throw err;
  }

  if (!token) {
    return { emailVerificationRequired: true, email: parsed.data.email, next };
  }

  // autoSignIn (packages/auth/src/config.ts) means this is already a real
  // session, and there's no email-confirmation step — signup behaves like
  // an immediate login straight into the app. safeNext (same helper login()
  // uses) forwards an invite/other `next` target carried from /login's
  // "Create an account" link (LoginForm.tsx) so a brand-new user lands back
  // where they started (e.g. /invite/<token>) instead of always at /app.
  return { success: true, token, next };
}

const verifySignupEmailSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  otp: z.string().min(1, "Enter your code"),
});

/**
 * Email Phase 3 security fix, step 2: completes the gated-signup
 * verification started by signup() above. Confirms the OTP sent to
 * `email` (via sendAuthEmail's "email-verification" branch, already wired
 * for Email Phase 2) and, since `emailVerification.autoSignInAfterVerification`
 * is set (packages/auth/src/config.ts), better-auth creates a real session
 * on success — same `{success, token, next}` shape signup() itself returns
 * on the ungated path, so SignupForm's existing post-signup effect (store
 * token, navigate to `next`) handles both identically.
 */
export async function verifySignupEmail(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = verifySignupEmailSchema.safeParse({
    email: formData.get("email"),
    otp: formData.get("otp"),
  });
  const next = safeNext(formData.get("next"));
  if (!parsed.success) {
    return { emailVerificationRequired: true, email: String(formData.get("email") ?? ""), next, fieldErrors: parsed.error.flatten().fieldErrors };
  }

  if (await isAuthActionRateLimited("signup-email-verify", parsed.data.email, OTP_VERIFY_LIMIT)) {
    return { emailVerificationRequired: true, email: parsed.data.email, next, error: INVALID_CODE_MESSAGE };
  }

  let token: string | null;
  try {
    const result = await getAuth().api.verifyEmailOTP({ body: { email: parsed.data.email, otp: parsed.data.otp } });
    token = result.token;
  } catch (err) {
    if (err instanceof APIError) {
      return { emailVerificationRequired: true, email: parsed.data.email, next, error: INVALID_CODE_MESSAGE };
    }
    throw err;
  }

  if (!token) {
    return { emailVerificationRequired: true, email: parsed.data.email, next, error: "Something went wrong. Try again." };
  }

  revalidatePath("/", "layout");
  return { success: true, token, next };
}

const emailOnlySchema = z.object({ email: z.string().email("Enter a valid email address") });

/**
 * Email Phase 2 — "Email me a code" (login-by-code). Always returns the
 * same generic message whether or not the account exists: better-auth's
 * own sendVerificationOTP throws for a genuinely unknown email (unlike
 * core's requestPasswordReset, which does its own dummy lookup), so the
 * try/catch below is what actually prevents that from leaking as a
 * different outcome. A rate-limited caller gets the identical message
 * too (and the OTP send is skipped entirely) — a different response here
 * would itself be a side channel for probing which emails exist.
 */
export async function requestLoginCode(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = emailOnlySchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }
  if (!(await isAuthActionRateLimited("login-code-request", parsed.data.email, OTP_REQUEST_LIMIT))) {
    try {
      await getAuth().api.sendVerificationOTP({ body: { email: parsed.data.email, type: "sign-in" } });
    } catch {
      // Swallow — same generic response either way, see header comment.
    }
  }
  return { message: GENERIC_CODE_SENT_MESSAGE };
}

const loginWithCodeSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  otp: z.string().min(1, "Enter your code"),
});

/**
 * Completes login-by-code. `/sign-in/email-otp` is not one of the paths
 * twoFactor()'s own hook matches (only /sign-in/email, /sign-in/username,
 * /sign-in/phone-number — see node_modules/better-auth's two-factor
 * plugin), so this never short-circuits into a twoFactorRedirect the way
 * login()'s /sign-in/email does. That's fine: the session it creates still
 * has `twoFactorVerifiedAt` unset, so requireStaff (apps/api) still forces
 * a staff account to /console-enroll before reaching /console — the 2FA
 * gate lives there, independent of how the session was created.
 */
export async function loginWithCode(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = loginWithCodeSchema.safeParse({
    email: formData.get("email"),
    otp: formData.get("otp"),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  // Same generic "invalid or expired" response a wrong code gets — see
  // OTP_VERIFY_LIMIT's comment above.
  if (await isAuthActionRateLimited("login-code-verify", parsed.data.email, OTP_VERIFY_LIMIT)) {
    return { error: INVALID_CODE_MESSAGE };
  }

  let token: string;
  try {
    const result = await getAuth().api.signInEmailOTP({ body: parsed.data });
    token = result.token;
  } catch (err) {
    if (err instanceof APIError) {
      return { error: INVALID_CODE_MESSAGE };
    }
    throw err;
  }

  revalidatePath("/", "layout");
  return { success: true, token, next: safeNext(formData.get("next")) };
}

/**
 * Email Phase 2 — forgot password, step 1. Same no-enumeration contract as
 * requestLoginCode: always the identical generic message.
 */
export async function requestPasswordReset(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = emailOnlySchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }
  if (!(await isAuthActionRateLimited("password-reset-request", parsed.data.email, OTP_REQUEST_LIMIT))) {
    try {
      await getAuth().api.requestPasswordResetEmailOTP({ body: { email: parsed.data.email } });
    } catch {
      // Swallow — same generic response either way, see header comment.
    }
  }
  return { message: GENERIC_CODE_SENT_MESSAGE };
}

const resetPasswordSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  otp: z.string().min(1, "Enter your code"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

/**
 * Email Phase 2 — forgot password, step 2. Sequence: reset the password
 * via the OTP (resetPasswordEmailOTP doesn't create a session — only
 * rewrites the password hash) -> delete every existing session for the
 * account server-side -> notify it by email -> redirect to /login so the
 * user re-authenticates with the new password.
 *
 * Deliberately does NOT sign the user back in (no signInEmail call): a
 * password reset is treated as "every prior session, including whatever
 * browser is sitting on this form, is now untrusted" — auto-login would
 * undermine that for the one session this flow itself would otherwise
 * create. Deleted via a direct SQL delete, not better-auth's own
 * `/revoke-sessions` endpoint — that endpoint requires an existing
 * authenticated session to scope to (sensitiveSessionMiddleware +
 * requireHeaders), which this flow never has. Same direct-pool precedent
 * as createOrganization/switchOrg below.
 */
export async function resetPasswordWithCode(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = resetPasswordSchema.safeParse({
    email: formData.get("email"),
    otp: formData.get("otp"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  if (await isAuthActionRateLimited("password-reset-verify", parsed.data.email, OTP_VERIFY_LIMIT)) {
    return { error: INVALID_CODE_MESSAGE };
  }

  try {
    await getAuth().api.resetPasswordEmailOTP({
      body: { email: parsed.data.email, otp: parsed.data.otp, password: parsed.data.password },
    });
  } catch (err) {
    if (err instanceof APIError) {
      return { error: INVALID_CODE_MESSAGE };
    }
    throw err;
  }

  await getPool().query(
    'delete from public.session where "userId" = (select id from public."user" where email = $1)',
    [parsed.data.email],
  );

  await enqueueEmail({
    kind: "send_email",
    to: parsed.data.email,
    payload: { template: "passwordChanged", data: { whenText: new Date().toUTCString() } },
  });

  revalidatePath("/", "layout");
  redirect(`/login?message=${encodeURIComponent(PASSWORD_CHANGED_MESSAGE)}`);
}

// Console v1 Slice 4 (docs/plans/console-plan.md §4b, build order step 14):
// enrollment state for the /console-enroll screen. Deliberately its own
// type, not a reuse of ActionState — enrollment returns totpURI/secret/
// backupCodes, none of which any other action produces, and never carries
// `next`/`twoFactorRequired` (those are sign-in-flow-only concerns).
export type EnrollActionState = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
  // Set once enableTwoFactorEnrollment() succeeds; ConsoleEnrollClient uses
  // this to switch from the password-confirm step to the QR/verify step.
  totpURI?: string;
  // Parsed out of totpURI's `secret` query param so the screen can show it
  // as plain text for manual entry (plan item #5), without the client
  // needing its own otpauth:// URI parser.
  secret?: string;
  backupCodes?: string[];
} | null;

const enableTwoFactorSchema = z.object({
  password: z.string().min(1, "Enter your password to continue"),
});

/**
 * Step 1 of enrollment: confirm the signed-in staff member's password (the
 * `enableTwoFactor` endpoint requires it whenever email/password auth is
 * configured — see better-auth's `two-factor/index.d.mts` body union), then
 * return the TOTP secret/QR URI + backup codes. `headers()` carries the
 * caller's existing session cookie (they're already signed in — this runs
 * from the /console-enroll screen, reached only after requireStaff's
 * STAFF_2FA_REQUIRED gate), so no separate session lookup is needed.
 */
export async function enableTwoFactorEnrollment(
  _prevState: EnrollActionState,
  formData: FormData,
): Promise<EnrollActionState> {
  const parsed = enableTwoFactorSchema.safeParse({ password: formData.get("password") });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  try {
    const requestHeaders = await headers();
    const result = await getAuth().api.enableTwoFactor({
      body: { password: parsed.data.password, method: "totp" },
      headers: requestHeaders,
    });
    if (result.method !== "totp") {
      return { error: "Something went wrong. Try again." };
    }
    const secret = new URL(result.totpURI).searchParams.get("secret") ?? "";
    return { totpURI: result.totpURI, secret, backupCodes: result.backupCodes };
  } catch (err) {
    if (err instanceof APIError) {
      return { error: err.message || "Couldn't enable two-factor. Try again." };
    }
    throw err;
  }
}

const verifyEnrollmentSchema = z.object({
  code: z.string().min(1, "Enter your verification code"),
});

/**
 * Step 2 of enrollment: confirm the authenticator app is actually set up
 * correctly. Calls the same `verifyTOTP` endpoint login's verifyTwoFactor()
 * uses, but reaches the "already signed in" branch of better-auth's shared
 * verifyTwoFactor(ctx) helper (no 2FA challenge cookie exists here — the
 * caller has a normal session).
 */
export async function verifyTwoFactorEnrollment(
  _prevState: EnrollActionState,
  formData: FormData,
): Promise<EnrollActionState> {
  const parsed = verifyEnrollmentSchema.safeParse({ code: formData.get("code") });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  try {
    const requestHeaders = await headers();
    await getAuth().api.verifyTOTP({ body: { code: parsed.data.code }, headers: requestHeaders });
    // better-auth's verifyTOTP swaps the session cookie server-side
    // (deletes the pre-enrollment session, issues a new one) as part of
    // *this* request/response. Letting the client navigate afterwards
    // (router.push, or even a hard window.location.href from a useEffect)
    // races Next's own automatic post-action re-render of the current
    // page (/console-enroll): that re-render still reads the *original*
    // incoming request's cookies (the now-deleted old token), so
    // page.tsx's `if (!user) redirect('/login')` fires first and wins —
    // landing on /login (then bounced to /app by middleware, since the
    // new cookie *is* valid by then). Calling redirect() here, inside the
    // action itself and after the cookie swap, skips that stale re-render
    // entirely: Next sends the redirect instruction directly instead of
    // re-rendering /console-enroll, and the client's next request for
    // /console goes out only after it has already applied the new cookie.
    redirect("/console");
  } catch (err) {
    if (err instanceof APIError) {
      return { error: err.message || "Invalid code. Try again." };
    }
    throw err;
  }
}

export async function logout(): Promise<void> {
  const requestHeaders = await headers();
  await getAuth().api.signOut({ headers: requestHeaders });
  revalidatePath("/", "layout");
  redirect("/login");
}

const onboardingSchema = z.object({
  name: z.string().min(1, "Organization name is required"),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and hyphens only"),
});

export async function createOrganization(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = onboardingSchema.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const user = await getSessionUser();
  if (!user) return { error: "Your session expired — sign in again." };

  let orgId: string;
  try {
    const result = await withActingUser(getPool(), user.id, (db) =>
      db.query<{ create_organization: string }>("select public.create_organization($1, $2)", [
        parsed.data.name,
        parsed.data.slug,
      ]),
    );
    orgId = result.rows[0]!.create_organization;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Something went wrong. Try again." };
  }

  revalidatePath("/", "layout");
  redirect(`/app?org=${orgId}`);
}

/**
 * Org switcher (Subscription Phase 2): sets ACTIVE_ORG_COOKIE so the next
 * requireUser() call (this file, session.ts) — and apps/api's attachActor,
 * which reads the same cookie via the browser's same-origin
 * /api/backend/:path* rewrite — resolve to this org instead of the oldest
 * membership. Validates the caller is actually a member of orgId first
 * (RLS-scoped query, not trusted client input) so a stale/forged cookie
 * value can never grant access to an org the user isn't in — worst case,
 * pickActiveMembership()'s fallback just treats it as a non-match and
 * falls back to the oldest membership, but rejecting it here keeps a bad
 * value from ever being set to begin with.
 */
export async function switchOrg(orgId: string): Promise<void> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const result = await withActingUser(getPool(), user.id, (db) =>
    db.query<{ org_id: string }>(
      "select org_id from public.organization_members where org_id = $1 and user_id = $2",
      [orgId, user.id],
    ),
  );
  if (result.rows.length === 0) {
    throw new Error("You are not a member of that organization.");
  }

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_ORG_COOKIE, orgId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });

  revalidatePath("/", "layout");
}
