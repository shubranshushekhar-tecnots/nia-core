import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Bootstrap endpoint for lib/auth/browserSession.ts's `ensureBearerToken()`.
 * Reads the raw session token straight off the incoming (httpOnly) session
 * cookie — no DB round-trip, this is just a relay so client JS can get at
 * a value it otherwise can't read directly. Real verification happens
 * downstream at apps/api's `requireAuth`/`requireCookieAuth`, same trust
 * model as the existing cookie-forwarding helpers (lib/api/chatServer.ts).
 */
export async function GET() {
  const token = getSessionCookie(await headers());
  return NextResponse.json({ token });
}
