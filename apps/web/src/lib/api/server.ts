import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL!;

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
 * off the cookie-derived server-side Supabase client (kept fresh by
 * middleware) instead of the browser client. No 401-refresh-retry: by the
 * time a Server Component runs, middleware has already revalidated/
 * refreshed the session for this request, so a 401 here means a real
 * server-to-server problem, not a stale-token race.
 */
export async function apiFetchServer<T>(path: string, init?: RequestInit): Promise<T> {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    redirect('/login');
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
      Authorization: `Bearer ${session.access_token}`,
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
