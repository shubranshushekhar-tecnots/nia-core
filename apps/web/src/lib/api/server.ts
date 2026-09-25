import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getSessionCookie } from 'better-auth/cookies';

// Internal, Docker-network address of apps/api — same var next.config.mjs's
// rewrite target and chatServer.ts read. Not NEXT_PUBLIC_-prefixed: must
// stay a real runtime env var, never inlined into the client bundle at
// build time (docs/plans/web-container.md's revised design).
const API_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4001';

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Server Component / Server Action equivalent of lib/api/client.ts's
 * apiFetch — same Express origin, same error shape, but the token comes
 * straight off the incoming request's httpOnly session cookie via
 * getSessionCookie() (better-auth/cookies) — a pure cookie-parse, no DB
 * round-trip. apps/api's bearer plugin accepts this value as-is (it's
 * already a valid session token, signed or not — see packages/auth's
 * bearer() config and better-auth's bearer plugin, which self-signs an
 * unsigned token using the same secret). No 401-refresh-retry: by the
 * time a Server Component runs, middleware has already redirected any
 * request with no session cookie at all, so a 401 here means a real
 * server-to-server problem, not a stale-token race.
 */
export async function apiFetchServer<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getSessionCookie(await headers());

  if (!token) {
    redirect('/login');
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
      Authorization: `Bearer ${token}`,
    },
    cache: 'no-store',
  });

  if (res.status === 409) {
    const body = await res.json().catch(() => null);
    if (body?.error?.code === 'ORG_REQUIRED') {
      redirect('/onboarding');
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(
      res.status,
      body?.error?.code ?? 'UNKNOWN',
      body?.error?.message ?? res.statusText,
      body?.error?.details,
    );
  }

  // 204 No Content (e.g. DELETE routes) has no body to parse — every caller
  // so far has been a GET with a JSON body, so this never came up until
  // Step 5's mutations (POST/PATCH/DELETE) started using this helper.
  if (res.status === 204) return undefined as T;

  return res.json() as Promise<T>;
}
