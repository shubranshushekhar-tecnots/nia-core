import type { EntityProfile, EntityRef, IntrospectResponse } from '@nia/schemas';
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

/**
 * Phase 10 — Profile tab's read path (cached, <=24h old, same-schema
 * profile if one exists; otherwise the server re-profiles synchronously
 * before responding — see apps/api/src/services/connections.ts's
 * getConnectionProfile).
 */
export async function getConnectionProfile(connectionId: string, entity: EntityRef): Promise<EntityProfile> {
  const params = new URLSearchParams({ namespace: entity.namespace, name: entity.name });
  const res = await fetch(`/api/backend/connections/${connectionId}/profile?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json', ...(await authHeaders()) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ConnectionsApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? res.statusText);
  }
  return res.json() as Promise<EntityProfile>;
}

/** Manual "Refresh" affordance — always re-profiles, bypassing the 24h cache check. */
export async function refreshConnectionProfile(connectionId: string, entity: EntityRef): Promise<EntityProfile> {
  const res = await fetch(`/api/backend/connections/${connectionId}/profile/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(entity),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ConnectionsApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? res.statusText);
  }
  return res.json() as Promise<EntityProfile>;
}

/**
 * Mirrors apps/api/src/services/grants.ts's WriteGrant shape exactly (that
 * type lives in apps/api, not @nia/schemas, since it's server-only — see
 * that file's header comment). Browser-side JSON contract for
 * GET /connections/:id/grants, used by NodeDrawer.tsx (Phase 6 Block 2) to
 * decide which write verbs unlock for a selected entity.
 */
export type WriteGrant = {
  id: string;
  connectionId: string;
  grantedByUserId: string;
  scope: Record<string, unknown>;
  grantedAt: string;
  revokedAt: string | null;
  confirmedAt: string | null;
  credVersion: number;
  writeCredentialVaultRef: string | null;
};

export async function getWriteGrants(connectionId: string): Promise<WriteGrant[]> {
  const res = await fetch(`/api/backend/connections/${connectionId}/grants`, {
    method: 'GET',
    headers: { Accept: 'application/json', ...(await authHeaders()) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ConnectionsApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? res.statusText);
  }
  return res.json() as Promise<WriteGrant[]>;
}

/**
 * Phase 6 Block 5 — create/confirm/revoke wrappers backing the
 * grant-creation UI (NodeDrawer.tsx's GrantAccessPanel). Mirrors
 * apps/api/src/routes/grants.ts's contract exactly: create takes a scope,
 * confirm takes the raw `{ user, password }` credential (the server writes
 * it to Vault, see grants.ts's service comment), revoke takes only the
 * grant id.
 */
export async function createWriteGrant(connectionId: string, scope: Record<string, unknown>): Promise<WriteGrant> {
  const res = await fetch(`/api/backend/connections/${connectionId}/grants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ scope }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ConnectionsApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? res.statusText);
  }
  return res.json() as Promise<WriteGrant>;
}

export async function confirmWriteGrant(
  connectionId: string,
  grantId: string,
  credential: { user: string; password: string },
): Promise<WriteGrant> {
  const res = await fetch(`/api/backend/connections/${connectionId}/grants/${grantId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ credential }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ConnectionsApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? res.statusText);
  }
  return res.json() as Promise<WriteGrant>;
}

export async function revokeWriteGrant(connectionId: string, grantId: string): Promise<WriteGrant> {
  const res = await fetch(`/api/backend/connections/${connectionId}/grants/${grantId}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json', ...(await authHeaders()) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ConnectionsApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? res.statusText);
  }
  return res.json() as Promise<WriteGrant>;
}
