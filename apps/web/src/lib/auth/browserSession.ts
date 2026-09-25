/**
 * Browser-side bearer token storage for calls apps/api's Bearer-only
 * routes (see apps/api/src/middleware/auth.ts's `requireAuth`) made
 * directly from Client Components — e.g. graphClient.ts's autosave,
 * connectionsClient.ts, previewClient.ts, etc.
 *
 * Better Auth's session cookie is httpOnly, so client JS can't read it the
 * way Supabase's browser client previously exposed `session.access_token`.
 * Instead: `login`/`signup` (Server Actions, lib/auth/actions.ts) capture
 * the `set-auth-token` response header from the `bearer()` plugin
 * (packages/auth/src/config.ts) and hand it back to the client component,
 * which stores it here. `ensureBearerToken()` falls back to the
 * `/api/auth-token` Route Handler (which re-derives it from the httpOnly
 * cookie server-side) when localStorage is empty — e.g. a fresh tab, or
 * after the 30-day-rolling cookie renewed server-side without the client
 * knowing.
 */

const STORAGE_KEY = "nia_bearer_token";

export function getStoredBearerToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(STORAGE_KEY);
}

export function setStoredBearerToken(token: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, token);
}

export function clearStoredBearerToken(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}

/**
 * Returns a usable bearer token for the current session, or `null` if
 * signed out. Checks localStorage first; on a miss, asks `/api/auth-token`
 * (same-origin, forwards the httpOnly session cookie automatically) and
 * caches the result.
 */
export async function ensureBearerToken(): Promise<string | null> {
  const cached = getStoredBearerToken();
  if (cached) return cached;

  const res = await fetch("/api/auth-token", { credentials: "same-origin" });
  if (!res.ok) return null;

  const { token } = (await res.json()) as { token: string | null };
  if (token) setStoredBearerToken(token);
  return token;
}
