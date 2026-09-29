"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { APIError } from "better-auth/api";
import { withActingUser } from "@nia/db";
import { getAuth } from "@/lib/auth/auth";
import { getSessionUser } from "@/lib/auth/session";
import { getPool } from "@/lib/db/pool";

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
} | null;

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

export async function signup(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = signupSchema.safeParse({
    fullName: formData.get("fullName"),
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  let token: string;
  try {
    const requestHeaders = await headers();
    const result = await getAuth().api.signUpEmail({
      body: { email: parsed.data.email, password: parsed.data.password, name: parsed.data.fullName },
      headers: requestHeaders,
    });
    // autoSignIn (packages/auth/src/config.ts) means this is only null if
    // email verification were required (it isn't — see config), so this
    // should never happen in practice; typed as nullable regardless.
    if (!result.token) return { error: "Something went wrong. Try again." };
    token = result.token;
  } catch (err) {
    if (err instanceof APIError) {
      return { error: err.message || "Something went wrong. Try again." };
    }
    throw err;
  }

  // autoSignIn (packages/auth/src/config.ts) means this is already a real
  // session, and there's no email-confirmation step — signup behaves like
  // an immediate login straight into the app.
  return { success: true, token, next: "/app" };
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
