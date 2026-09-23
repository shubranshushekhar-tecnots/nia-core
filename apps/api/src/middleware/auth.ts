import type { NextFunction, Request, RequestHandler, Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { createRequestSupabaseClient } from "../lib/supabaseClient.js";

const BEARER_PREFIX = "Bearer ";

/**
 * The one and only place a Bearer token is read off a request. Validates
 * it against Supabase Auth (supabase.auth.getUser(jwt) round-trips to
 * GoTrue rather than trusting a locally-decoded JWT), then builds the
 * per-request client every downstream handler must use for data access —
 * never a shared/service-role client. RLS keeps doing the real enforcement
 * unchanged; this middleware only establishes who is asking.
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

  const supabase = createRequestSupabaseClient(token);
  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    next(new AppError(401, "NOT_AUTHENTICATED", "Invalid or expired session."));
    return;
  }

  req.supabase = supabase;
  req.authUser = { id: data.user.id, email: data.user.email ?? "" };
  next();
});
