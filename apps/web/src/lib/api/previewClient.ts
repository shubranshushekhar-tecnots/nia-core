import type { PreviewValue } from '@nia/schemas';
import { createClient } from '@/lib/supabase/client';

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

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'PreviewApiError';
    this.status = status;
    this.code = code;
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await createClient().auth.getSession();
  if (!session) throw new PreviewApiError(401, 'NOT_AUTHENTICATED', 'No active session.');
  return { Authorization: `Bearer ${session.access_token}` };
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
    throw new PreviewApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? res.statusText);
  }
  return res.json() as Promise<PreviewValue>;
}
