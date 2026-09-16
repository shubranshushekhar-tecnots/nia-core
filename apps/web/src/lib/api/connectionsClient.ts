import type { IntrospectResponse } from '@nia/schemas';
import { createClient } from '@/lib/supabase/client';

/**
 * Browser-side calls for connection-scoped reads needed by client components
 * (e.g. the canvas transform editor's field picker). Same same-origin-proxy
 * target as graphClient.ts (`/api/backend/:path*`), same Bearer-only auth
 * convention (requireAuth, not cookie-authenticated) — see graphClient.ts's
 * header comment for the full rationale.
 */

export class ConnectionsApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ConnectionsApiError';
    this.status = status;
    this.code = code;
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await createClient().auth.getSession();
  if (!session) throw new ConnectionsApiError(401, 'NOT_AUTHENTICATED', 'No active session.');
  return { Authorization: `Bearer ${session.access_token}` };
}

/**
 * A miss (404) means the connection doesn't exist OR isn't visible to this
 * actor's workspace scope — RLS-scoped reads are indistinguishable from
 * not-found by design (anti-enumeration convention), mirroring every other
 * /connections/:id sub-route in apps/api/src/routes/connections.ts.
 */
export async function getConnectionSchema(connectionId: string): Promise<IntrospectResponse> {
  const res = await fetch(`/api/backend/connections/${connectionId}/schema`, {
    method: 'GET',
    headers: { Accept: 'application/json', ...(await authHeaders()) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ConnectionsApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? res.statusText);
  }
  return res.json() as Promise<IntrospectResponse>;
}
