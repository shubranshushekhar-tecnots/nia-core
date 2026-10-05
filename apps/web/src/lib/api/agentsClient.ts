import { ensureBearerToken } from '@/lib/auth/browserSession';
import { mapAgents } from '@/lib/agents/mapAgent';
import type { PlatformAgent } from '@/lib/agents/types';

/**
 * Browser-side poll for the Agents list — AgentsClient.tsx re-fetches this
 * every ~15s while the page is open (B.13's "online/offline" status is
 * derived from last_check_in_at, so the list needs to keep refreshing to
 * stay accurate). Same same-origin-proxy + Bearer-only auth convention as
 * connectionsClient.ts.
 */

export class AgentsApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AgentsApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await ensureBearerToken();
  if (!token) throw new AgentsApiError(401, 'NOT_AUTHENTICATED', 'No active session.');
  return { Authorization: `Bearer ${token}` };
}

export async function listAgentsClient(): Promise<PlatformAgent[]> {
  const res = await fetch('/api/backend/agents', {
    method: 'GET',
    headers: { Accept: 'application/json', ...(await authHeaders()) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new AgentsApiError(
      res.status,
      body?.error?.code ?? 'UNKNOWN',
      body?.error?.message ?? res.statusText,
      body?.error?.details,
    );
  }
  const raw = (await res.json()) as unknown[];
  return mapAgents(raw);
}
