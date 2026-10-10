import { createHash } from "node:crypto";
import { withServiceRole } from "@nia/db";
import { getPool } from "@/lib/db/pool";
import { getRedis } from "@/lib/auth/rateLimit";

// Email Phase 3 signup gate. Three independent allow-paths for a brand-new
// email to create an account when SIGNUP_MODE=request (lib/auth/auth.ts):
//   1. An approved access_requests row (public "Request access" flow).
//   2. A pending, unexpired platform_invites row (staff direct invite).
//   3. A short-lived, single-use Redis flag — the bridge for org invites
//      (/invite/<token>) and platform invites (/accept-invite/<token>),
//      whose tokens aren't visible to better-auth's validateUserInfo hook
//      (it only sees {user}, not the original request/next param). signup()
//      (lib/auth/actions.ts) sets this flag after read-only-validating the
//      relevant token, immediately before calling signUpEmail.
const SIGNUP_ALLOW_TTL_SECONDS = 600;

function signupAllowKey(email: string): string {
  return `signup-allow:${email.toLowerCase()}`;
}

/**
 * True if `email` already has a standing allowlist entry (paths 1/2 above).
 * Read-only — safe to call more than once for the same signup attempt.
 */
export async function isSignupAllowed(email: string): Promise<boolean> {
  return withServiceRole(getPool(), async (db) => {
    const approved = await db.query(
      `select 1 from public.access_requests where lower(email) = lower($1) and status = 'approved' limit 1`,
      [email],
    );
    if (approved.rows.length > 0) return true;

    const invited = await db.query(
      `select 1 from public.platform_invites
       where lower(email) = lower($1) and status = 'pending' and expires_at > now()
       limit 1`,
      [email],
    );
    return invited.rows.length > 0;
  });
}

/**
 * Sets the one-time bridge flag (path 3 above). EX 600 is generous for the
 * time between signup()'s token check and its signUpEmail call (same
 * request) while still expiring well before it could ever be reused.
 */
export async function allowSignupOnce(email: string): Promise<void> {
  await getRedis().set(signupAllowKey(email), "1", "EX", SIGNUP_ALLOW_TTL_SECONDS);
}

/**
 * The gate itself — passed as `checkSignupAllowed` to packages/auth's
 * createAuth() (lib/auth/auth.ts), invoked from inside `validateUserInfo`.
 * Consumes the one-time flag (GET+DEL) so a second create-user attempt for
 * the same email can't ride the same bridge twice; the two standing
 * allow-paths are unaffected by repeated calls.
 */
export async function checkSignupAllowed(email: string): Promise<boolean> {
  if (await isSignupAllowed(email)) return true;

  const redis = getRedis();
  const key = signupAllowKey(email);
  const value = await redis.get(key);
  if (!value) return false;
  await redis.del(key);
  return true;
}

/**
 * Read-only peek at an org invite_links token for signup()'s bridge —
 * deliberately does NOT increment `uses`; that still happens exactly where
 * it does today, in invites/actions.ts's acceptInvite() after redirect.
 * Needs withServiceRole (not a plain authenticated query) because
 * invite_links_select_admin (0058_invite_links.sql) requires org
 * admin/owner membership, which a brand-new not-yet-created user can never
 * have — this is the one legitimate case of reading it from outside that
 * policy, gated on knowing the raw token itself (effectively a bearer
 * credential) rather than org membership.
 */
export async function isOrgInviteTokenValid(rawToken: string): Promise<boolean> {
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  return withServiceRole(getPool(), async (db) => {
    const result = await db.query<{ ok: boolean }>(
      `select true as ok
       from public.invite_links
       where token_hash = $1
         and revoked_at is null
         and expires_at > now()
         and (max_uses is null or uses < max_uses)`,
      [tokenHash],
    );
    return result.rows.length > 0;
  });
}

/**
 * Read-only peek at a platform_invites token for signup()'s bridge.
 * Returns the invite's own email (lowercased) so the caller can enforce
 * the email-bound check itself (unlike invite_links' advisory-only
 * email_domain, a platform invite's email must match exactly) — returns
 * null for any invalid/expired/consumed token, same shape either way so
 * the caller never needs to distinguish "not found" from "expired".
 */
export async function peekPlatformInviteEmail(rawToken: string): Promise<string | null> {
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  return withServiceRole(getPool(), async (db) => {
    const result = await db.query<{ email: string }>(
      `select email
       from public.platform_invites
       where token_hash = $1 and status = 'pending' and expires_at > now()`,
      [tokenHash],
    );
    return result.rows[0]?.email.toLowerCase() ?? null;
  });
}
