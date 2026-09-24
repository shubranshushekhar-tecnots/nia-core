import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { OrgRole } from "@nia/schemas";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import type { OrgRef, UserWithOrg } from "../lib/actorTypes.js";

/**
 * Express port of apps/web/src/lib/auth/session.ts's requireUser(). Same
 * two queries, same "oldest membership wins" default org, same
 * "individual" synthetic role for org-less users. Reads go through
 * req.withUser (docs/plans/data-access.md's Step 3) instead of
 * req.supabase — withActingUser's SET LOCAL ROLE authenticated +
 * request.jwt.claims makes every RLS policy apply exactly as it did
 * through PostgREST, just reached via direct SQL. Must run after
 * requireAuth + attachDb so req.withUser/req.authUser are set.
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

  // Two independent PostgREST calls today -> two independent withUser
  // calls here (client.ts's N-separate-transactions rule), still run in
  // parallel via Promise.all to match today's behaviour.
  const [profileResult, membershipResult] = await Promise.all([
    withUser((db) =>
      db.query<{ full_name: string | null }>("SELECT full_name FROM profiles WHERE id = $1", [authUser.id]),
    ),
    withUser((db) =>
      db.query<{ role: OrgRole; org_id: string; org_name: string; org_slug: string }>(
        `SELECT om.role, o.id AS org_id, o.name AS org_name, o.slug AS org_slug
         FROM organization_members om
         JOIN organizations o ON o.id = om.org_id
         WHERE om.user_id = $1
         ORDER BY om.created_at ASC
         LIMIT 1`,
        [authUser.id],
      ),
    ),
  ]);

  const profile = profileResult.rows[0];
  const membership = membershipResult.rows[0];
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
