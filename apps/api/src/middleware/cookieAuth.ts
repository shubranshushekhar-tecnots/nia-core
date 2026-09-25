import type { NextFunction, Request, RequestHandler, Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { auth } from "../lib/auth.js";

/**
 * Cookie-based sibling of middleware/auth.ts's requireAuth, for the chat,
 * runs and copilot-agent routes only. Those are reached same-origin
 * through the browser via Next.js's /api/backend/:path* rewrite (see
 * apps/web/next.config.mjs), so the browser never holds a bearer token for
 * them — just the same httpOnly `better-auth.session_token` cookie
 * apps/web's Server Components read.
 *
 * `returnHeaders: true` + forwarding any resulting Set-Cookie is what
 * makes the rolling session (packages/auth/src/config.ts's updateAge)
 * transparent here: when a session is close enough to expiry, Better
 * Auth's getSession call itself extends it and returns a refreshed
 * Set-Cookie, exactly like the old supabase-js client's silent
 * access-token refresh — same reasoning as apps/web/src/lib/supabase/
 * middleware.ts used to have. Failure goes through the same AppError ->
 * errorHandler path as requireAuth, which always renders a plain JSON
 * body — never a redirect: unlike a browser navigation, a fetch()/
 * EventSource caller has no use for a 3xx, and previously (bug #2 in the
 * verification report) got a confusing 307 instead of a clean error.
 */
export const requireCookieAuth: RequestHandler = asyncHandler(async function requireCookieAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const cookieHeader = req.header("cookie");
  const headers = new Headers();
  if (cookieHeader) headers.set("cookie", cookieHeader);

  const { response: session, headers: responseHeaders } = await auth.api.getSession({
    headers,
    returnHeaders: true,
  });

  if (!session) {
    next(new AppError(401, "NOT_AUTHENTICATED", "No valid session cookie."));
    return;
  }

  const refreshedCookie = responseHeaders.get("set-cookie");
  if (refreshedCookie) res.setHeader("Set-Cookie", refreshedCookie);

  req.authUser = { id: session.user.id, email: session.user.email };
  next();
});
