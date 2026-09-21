import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// "/dev" is a temporary, no-auth allowance for isolated component preview
// routes (e.g. /dev/hero-preview) — no sensitive data is ever rendered
// there. Remove this prefix once those routes are deleted or gated.
const PUBLIC_PREFIXES = ["/login", "/signup", "/forgot-password", "/reset-password", "/auth", "/dev"];

function isPublicPath(pathname: string): boolean {
  if (pathname === "/") return true;
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * `/api/*` (currently just the `/api/backend/:path*` rewrite to apps/api,
 * see next.config.mjs) is a fetch()/EventSource surface, never a browser
 * navigation — a 3xx redirect to /login is useless to those callers and
 * previously masked apps/api's own clean 401 JSON body behind a redirect
 * response the caller couldn't sensibly follow (fix-pass Step 2's bug #2).
 * Treated as its own category, not folded into PUBLIC_PREFIXES: those are
 * pages a signed-out user should be allowed to land on; this is the
 * opposite (still gets rejected, just with the redirect suppressed).
 */
function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * Refreshes the Supabase session cookie on every request and enforces the
 * auth boundary. This is the single session owner: Server Components
 * (lib/supabase/server.ts) can't persist cookies themselves (a Next.js
 * platform restriction), so they rely on middleware having already
 * refreshed the pair before they run. Uses getUser() (never getSession())
 * because only getUser() revalidates the token against Supabase Auth on
 * the server — getSession() just reads the (possibly stale/forged) cookie
 * payload.
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          supabaseResponse = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            supabaseResponse.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname, search } = request.nextUrl;
  const publicPath = isPublicPath(pathname);

  if (!user && !publicPath && !isApiPath(pathname)) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    redirectUrl.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(redirectUrl);
  }

  if (user && (pathname === "/login" || pathname === "/signup")) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/app";
    redirectUrl.search = "";
    return NextResponse.redirect(redirectUrl);
  }

  return supabaseResponse;
}
