import type { CleanProposalResult } from '@nia/schemas';
import { ensureBearerToken } from '@/lib/auth/browserSession';

/**
 * Browser-side call for the builder canvas's "Propose cleaning" action
 * (Phase 13, Step 7 — apps/api's POST /workflows/:id/clean/propose). Same
 * Bearer-auth pattern as mappingsClient.ts/checksClient.ts.
 */

export class CleanApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'CleanApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await ensureBearerToken();
  if (!token) throw new CleanApiError(401, 'NOT_AUTHENTICATED', 'No active session.');
  return { Authorization: `Bearer ${token}` };
}

/**
 * Blocks on the worker's BullMQ job (env.CLEAN_PROPOSE_TIMEOUT_MS — two
 * parallel LLM specialist calls plus a live sample of the upstream source),
 * same "callers must show a loading state" contract as proposeMapping().
 */
export async function proposeCleaning(workflowId: string, nodeId: string): Promise<CleanProposalResult> {
  const res = await fetch(`/api/backend/workflows/${workflowId}/clean/propose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ nodeId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new CleanApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? res.statusText, body?.error?.details);
  }
  return res.json() as Promise<CleanProposalResult>;
}
