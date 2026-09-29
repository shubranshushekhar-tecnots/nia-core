import type { NextFunction, Request, RequestHandler, Response } from "express";
import { withServiceRole } from "@nia/db";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { dbPool } from "../lib/dbPool.js";
import { auth } from "../lib/auth.js";
import { env } from "../env.js";

/**
 * Console v1 (docs/plans/console-plan.md, build order step 4). Gates every
 * `/console/*` route: 403s unless the caller has an active (non-revoked)
 * `public.platform_staff` row. Must run after requireAuth so req.authUser
 * is set.
 *
 * `platform_staff` has RLS enabled with ZERO policies (0039_platform_staff.sql)
 * — by design, per console-plan.md §2, the only paths that can ever read it
 * are the manageStaff.ts CLI (which runs as the DATABASE_URL owner role
 * directly, outside any request) and this one check. Reading it from inside
 * a live request therefore genuinely needs `withServiceRole` — the plan's
 * own §3 spec calls this out explicitly ("via a service-role query") — not
 * `req.withUser`, which narrows to `authenticated` and would see zero rows
 * against a zero-policy table regardless of staff status. This is a
 * deliberate, narrow exception to apps/api's general "never call
 * withServiceRole" rule (dbPool.ts's header comment): everywhere else,
 * withServiceRole would mean a general RLS bypass for ordinary application
 * reads, which is exactly what this project's trust boundary forbids; this
 * one call is scoped to a single boolean membership check against a table
 * no other route or service ever touches.
 */
export const requireStaff: RequestHandler = asyncHandler(async function requireStaff(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const authUser = req.authUser;
  if (!authUser) {
    next(new AppError(401, "NOT_AUTHENTICATED", "requireAuth must run before requireStaff."));
    return;
  }

  const { rowCount } = await withServiceRole(dbPool, (db) =>
    db.query("select 1 from public.platform_staff where user_id = $1 and revoked_at is null", [authUser.id]),
  );

  if (!rowCount) {
    next(new AppError(403, "NOT_STAFF", "Staff access required."));
    return;
  }

  // Console v1 Slice 4 (console-plan.md §4b, decision 17): staff also need
  // an active 2FA-verified session, no older than
  // STAFF_SESSION_MAX_AGE_SECONDS. This is deliberately a SECOND, independent
  // auth.api.getSession() call rather than reading req.authUser — requireAuth/
  // requireCookieAuth only ever populate req.authUser with {id, email}
  // (see their own tests' exact toEqual assertions), and extending that
  // shared shape for every route in the app just for this one gate would be
  // unwanted blast radius. consoleRouter always mounts the bearer-only
  // requireAuth ahead of requireStaff, so the Authorization header is
  // guaranteed present here.
  const header = req.header("authorization");
  const headers = new Headers(header ? { authorization: header } : undefined);
  const session = await auth.api.getSession({ headers });

  if (!session) {
    next(new AppError(401, "NOT_AUTHENTICATED", "Invalid or expired session."));
    return;
  }

  const twoFactorVerifiedAt = (session.session as { twoFactorVerifiedAt?: Date | null }).twoFactorVerifiedAt;
  if (!twoFactorVerifiedAt) {
    next(new AppError(403, "STAFF_2FA_REQUIRED", "Staff must complete 2FA to access the console."));
    return;
  }

  const sessionAgeSeconds = (Date.now() - new Date(session.session.createdAt).getTime()) / 1000;
  if (sessionAgeSeconds > env.STAFF_SESSION_MAX_AGE_SECONDS) {
    next(new AppError(403, "STAFF_SESSION_EXPIRED", "Staff session has expired; please sign in again."));
    return;
  }

  next();
});
