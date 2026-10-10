import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

// Paths reachable while signed out. `/downloads` and `/docs` are the public
// agent download/documentation pages — DownloadsPage reads `signedIn`
// itself to decide what to show, it does not require the middleware to
// gate the route.
const PUBLIC_PATHS = new Set(["/", "/login", "/signup", "/reset-password"]);
const PUBLIC_PREFIXES = ["/downloads", "/docs"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

// fetch()/EventSource callers (lib/api/*Client.ts, chatClient.ts,
// runsClient.ts) have no use for a 3xx redirect — real auth enforcement for
// these happens at apps/api's requireAuth/requireCookieAuth regardless.
function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * Edge-safe presence check only — `getSessionCookie` just reads the cookie
 * off the request, no DB round-trip. This is a UX redirect, not the
 * security boundary: `requireUser()` (lib/auth/session.ts) re-verifies via
 * a real `auth.api.getSession()` call in every Server Component/Action,
 * and apps/api's middleware re-verifies again for every API call. A
 * present-but-expired/forged cookie value here just means one extra hop
 * through a real check before being redirected there instead.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const hasSession = Boolean(getSessionCookie(request));

  if (!hasSession && !isPublicPath(pathname) && !isApiPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (hasSession && (pathname === "/login" || pathname === "/signup")) {
    const url = request.nextUrl.clone();
    url.pathname = "/app";
    url.search = "";
    return NextResponse.redirect(url);
  }

  const response = NextResponse.next();
  // Email Phase 2 review fix: the emailed reset link carries the OTP in
  // its query string (?email=...&otp=...) — a Referer header leaking that
  // URL to a third-party resource/link on this page would leak the code
  // itself. ResetPasswordForm.tsx strips those params from the visible URL
  // client-side once loaded; this header closes the gap for the moment
  // before that runs.
  if (pathname === "/reset-password") {
    response.headers.set("Referrer-Policy", "no-referrer");
  }
  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except static assets and image optimization
     * files, so the session cookie is checked on every page/action.
     */
    "/((?!_next/static|_next/image|favicon.ico|fonts/|video/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff|woff2|ttf|mp4|webm)$).*)",
  ],
};
