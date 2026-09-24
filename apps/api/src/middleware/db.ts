import type { NextFunction, Request, RequestHandler, Response } from "express";
import { withActingUser } from "@nia/db";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { dbPool } from "../lib/dbPool.js";

/**
 * Attaches req.withUser, a closure over the pool + the caller's own
 * authUser.id (see lib/withUser.ts's header comment for its calling
 * contract). Must run after requireAuth or requireCookieAuth, both of
 * which set req.authUser from a real Supabase Auth/GoTrue validation —
 * this middleware never itself authenticates anything, it only wires the
 * already-verified id into @nia/db's withActingUser.
 */
export const attachDb: RequestHandler = asyncHandler(async function attachDb(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const authUser = req.authUser;

  if (!authUser) {
    next(new AppError(401, "NOT_AUTHENTICATED", "requireAuth must run before attachDb."));
    return;
  }

  req.withUser = (fn) => withActingUser(dbPool, authUser.id, fn);
  next();
});
