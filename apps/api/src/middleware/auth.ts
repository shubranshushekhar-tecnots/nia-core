import type { NextFunction, Request, RequestHandler, Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { auth } from "../lib/auth.js";

const BEARER_PREFIX = "Bearer ";

/**
 * The one and only place a Bearer token is read off a request. Better
 * Auth's bearer plugin (packages/auth/src/config.ts) accepts this exact
 * header shape and resolves it against the real `session` table row (a
 * database round-trip, never a locally-decoded/trusted token) — same
 * verification guarantee the old supabase.auth.getUser(jwt) call made.
 * RLS keeps doing the real enforcement unchanged; this middleware only
 * establishes who is asking.
 */
export const requireAuth: RequestHandler = asyncHandler(async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.header("authorization");

  if (!header || !header.startsWith(BEARER_PREFIX)) {
    next(new AppError(401, "NOT_AUTHENTICATED", "Missing or malformed Authorization header."));
    return;
  }

  const token = header.slice(BEARER_PREFIX.length).trim();
  if (!token) {
    next(new AppError(401, "NOT_AUTHENTICATED", "Missing bearer token."));
    return;
  }

  const headers = new Headers({ authorization: header });
  const session = await auth.api.getSession({ headers });

  if (!session) {
    next(new AppError(401, "NOT_AUTHENTICATED", "Invalid or expired session."));
    return;
  }

  req.authUser = { id: session.user.id, email: session.user.email };
  next();
});
