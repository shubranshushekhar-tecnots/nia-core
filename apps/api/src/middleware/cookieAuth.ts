import type { NextFunction, Request, RequestHandler, Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { createCookieScopedSupabaseClient } from "../lib/cookieSupabaseClient.js";

/**
 * Cookie-based sibling of middleware/auth.ts's requireAuth, for the chat
 * routes only. Those are reached same-origin through the browser via
 * Next.js's /api/backend/:path* rewrite (see apps/web/next.config.mjs), so
 * the browser never holds a bearer token for them — just the same
 * httpOnly Supabase session cookies apps/web's Server Components read.
 *
 * getUser() (never getSession()) so an expired/forged cookie is rejected
 * server-side against Supabase Auth, not just trusted at face value — same
 * reasoning as apps/web/src/lib/supabase/middleware.ts. Failure goes
 * through the same AppError -> errorHandler path as requireAuth, which
 * always renders a plain JSON body — never a redirect: unlike a browser
 * navigation, a fetch()/EventSource caller has no use for a 3xx, and
 * previously (bug #2 in the verification report) got a confusing 307
 * instead of a clean error.
 */
export const requireCookieAuth: RequestHandler = asyncHandler(async function requireCookieAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const supabase = createCookieScopedSupabaseClient(req, res);
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) {
    next(new AppError(401, "NOT_AUTHENTICATED", "No valid session cookie."));
    return;
  }

  req.supabase = supabase;
  req.authUser = { id: data.user.id, email: data.user.email ?? "" };
  next();
});
