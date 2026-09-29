import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { OrgRole } from "@nia/schemas";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import type { OrgRef, UserWithOrg } from "../lib/actorTypes.js";

/**
 * Cookie set by apps/web's switchOrg() server action (lib/auth/
 * actions.ts) when a multi-org user picks which org to act in. Same name
 * on both sides — see that file's header comment for the full design.
 * Read here via the raw `cookie` header (same low-level approach as
 * cookieAuth.ts) since apps/api has no cookie-parser middleware; every
 * browser call reaches apps/api through Next's same-origin
 * /api/backend/:path* rewrite, so this cookie rides along on every
 * request regardless of whether requireAuth (Bearer) or requireCookieAuth
 * ran first.
 */
const ACTIVE_ORG_COOKIE = "nia_active_org";

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * Express port of apps/web/src/lib/auth/session.ts's requireUser(). Same
 * two queries, same "individual" synthetic role for org-less users. Reads
 * go through req.withUser (docs/plans/data-access.md's Step 3) instead of
 * req.supabase — withActingUser's SET LOCAL ROLE authenticated +
 * request.jwt.claims makes every RLS policy apply exactly as it did
 * through PostgREST, just reached via direct SQL. Must run after
 * requireAuth + attachDb so req.withUser/req.authUser are set.
 *
 * Org resolution (Subscription Phase 2, org switcher): fetches every
 * membership row (not just one), then picks whichever matches the
 * ACTIVE_ORG_COOKIE if present and valid, else falls back to the oldest
 * membership — identical fallback to the pre-switcher behaviour for users
 * who have never switched (no cookie) or whose cookie no longer points to
 * a real membership (org left, cookie stale). This is also what makes the
 * suspension check below correctly follow the *active* org: a user who is
 * a member of a suspended org A and a healthy org B is never blocked while
 * acting in B, since `membership` is B's row, not A's.
 */
export const attachActor: RequestHandler = asyncHandler(async function attachActor(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const withUser = req.withUser;
  const authUser = req.authUser;

  if (!withUser || !authUser) {
    next(new AppError(401, "NOT_AUTHENTICATED", "requireAuth and attachDb must run before attachActor."));
    return;
  }

  const activeOrgId = readCookie(req.header("cookie"), ACTIVE_ORG_COOKIE);

  // Two independent PostgREST calls today -> two independent withUser
  // calls here (client.ts's N-separate-transactions rule), still run in
  // parallel via Promise.all to match today's behaviour.
  const [profileResult, membershipResult] = await Promise.all([
    withUser((db) =>
      db.query<{ full_name: string | null }>("SELECT full_name FROM profiles WHERE id = $1", [authUser.id]),
    ),
    withUser((db) =>
      db.query<{
        role: OrgRole;
        org_id: string;
        org_name: string;
        org_slug: string;
        suspended_at: string | null;
        suspended_reason: string | null;
      }>(
        `SELECT om.role, o.id AS org_id, o.name AS org_name, o.slug AS org_slug,
                o.suspended_at, o.suspended_reason
         FROM organization_members om
         JOIN organizations o ON o.id = om.org_id
         WHERE om.user_id = $1
         ORDER BY om.created_at ASC`,
        [authUser.id],
      ),
    ),
  ]);

  const profile = profileResult.rows[0];
  const memberships = membershipResult.rows;
  const membership =
    (activeOrgId ? memberships.find((m) => m.org_id === activeOrgId) : undefined) ?? memberships[0];

  // Console stays reachable for staff (consoleRouter never runs this
  // middleware — see index.ts's mount-order comment), so this 403 only
  // ever blocks the org's own members' regular API traffic. Scoped to
  // exactly the org this request resolved to (membership.org_id) — never
  // affects a multi-org user's other orgs, since attachActor already only
  // ever resolves one org per request (see this file's header comment).
  if (membership && membership.suspended_at !== null) {
    next(
      new AppError(
        403,
        "ORG_SUSPENDED",
        "This organization has been suspended. Contact support.",
        { reason: membership.suspended_reason },
      ),
    );
    return;
  }

  const org: OrgRef | null = membership
    ? { id: membership.org_id, name: membership.org_name, slug: membership.org_slug }
    : null;

  req.actor = {
    userId: authUser.id,
    email: authUser.email,
    fullName: profile?.full_name ?? null,
    org: membership && org ? org : null,
    role: membership && org ? membership.role : "individual",
  };
  next();
});

/**
 * Express port of requireUserWithOrg(). A browser Server Component can
 * redirect an org-less user to /onboarding; an API can't, so this responds
 * 409 ORG_REQUIRED instead — same "org truly required" contract, just a
 * status code rather than a redirect. Must run after attachActor.
 */
export function requireOrgActor(req: Request, _res: Response, next: NextFunction): void {
  const actor = req.actor;

  if (!actor) {
    next(new AppError(401, "NOT_AUTHENTICATED", "attachActor must run before requireOrgActor."));
    return;
  }

  if (!actor.org || actor.role === "individual") {
    next(new AppError(409, "ORG_REQUIRED", "This action requires an organization."));
    return;
  }

  const withOrg: UserWithOrg = {
    userId: actor.userId,
    email: actor.email,
    fullName: actor.fullName,
    org: actor.org,
    role: actor.role,
  };
  req.actor = withOrg;
  next();
}
