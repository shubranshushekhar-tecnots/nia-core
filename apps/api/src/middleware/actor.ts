import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { OrgRole } from "@nia/schemas";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import type { OrgRef, UserWithOrg } from "../lib/actorTypes.js";

/**
 * Express port of apps/web/src/lib/auth/session.ts's requireUser(). Same
 * two queries, same "oldest membership wins" default org, same
 * "individual" synthetic role for org-less users, same plain RLS-scoped
 * reads (req.supabase, not a service-role client). Must run after
 * requireAuth so req.supabase/req.authUser are set.
 */
export const attachActor: RequestHandler = asyncHandler(async function attachActor(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const supabase = req.supabase;
  const authUser = req.authUser;

  if (!supabase || !authUser) {
    next(new AppError(401, "NOT_AUTHENTICATED", "requireAuth must run before attachActor."));
    return;
  }

  const [{ data: profile }, { data: memberships }] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", authUser.id).single(),
    supabase
      .from("organization_members")
      .select("role, created_at, organizations ( id, name, slug )")
      .eq("user_id", authUser.id)
      .order("created_at", { ascending: true })
      .limit(1),
  ]);

  const membership = memberships?.[0];
  const org = membership?.organizations as unknown as OrgRef | null;

  req.actor = {
    userId: authUser.id,
    email: authUser.email,
    fullName: profile?.full_name ?? null,
    org: membership && org ? org : null,
    role: membership && org ? (membership.role as OrgRole) : "individual",
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
