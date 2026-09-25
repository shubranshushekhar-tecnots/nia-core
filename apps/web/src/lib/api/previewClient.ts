import type { PreviewValue } from '@nia/schemas';
import { ensureBearerToken } from '@/lib/auth/browserSession';

/**
 * Browser-side call for the destination-node read preview (Block 1, Phase 5
 * Session 5 — apps/api's POST /workflows/:id/preview) — same Bearer-auth
 * pattern as mappingsClient.ts/checksClient.ts. Read-side only: nothing this
 * client calls ever persists anything, see services/preview.ts's header
 * comment.
 */

export class PreviewApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'PreviewApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await ensureBearerToken();
  if (!token) throw new PreviewApiError(401, 'NOT_AUTHENTICATED', 'No active session.');
  return { Authorization: `Bearer ${token}` };
}

/**
 * Blocks on the worker's BullMQ job (env.PREVIEW_TIMEOUT_MS) — callers must
 * show a loading state, and treat a timeout (503) as a clean retry
 * affordance rather than an indefinite spinner.
 */
export async function previewDestination(workflowId: string, destNodeId: string): Promise<PreviewValue> {
  const res = await fetch(`/api/backend/workflows/${workflowId}/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ destNodeId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new PreviewApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? res.statusText, body?.error?.details);
  }
  return res.json() as Promise<PreviewValue>;
}
