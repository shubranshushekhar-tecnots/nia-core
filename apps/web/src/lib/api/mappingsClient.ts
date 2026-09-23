import type { ProposalSchema } from '@nia/schemas';
import { createClient } from '@/lib/supabase/client';

/**
 * Browser-side call for the builder canvas's AI-proposed field mapping flow
 * (apps/api's POST /workflows/:id/mappings/propose) — same Bearer-auth
 * pattern as checksClient.ts. Only the propose call lives here: approving a
 * proposal is NOT a separate endpoint — it's an ordinary graph save
 * (graphClient.ts's putWorkflowGraph), since the mapping is just a field on
 * the destination node's own config (nodeConfig.ts's FieldMapping).
 */

export class MappingsApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'MappingsApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await createClient().auth.getSession();
  if (!session) throw new MappingsApiError(401, 'NOT_AUTHENTICATED', 'No active session.');
  return { Authorization: `Bearer ${session.access_token}` };
}

/**
 * Blocks on the worker's BullMQ job (env.MAPPING_PROPOSE_TIMEOUT_MS, an LLM
 * call) — callers must show a loading state, and treat a timeout (503) as a
 * clean retry affordance rather than an indefinite spinner.
 */
export async function proposeMapping(workflowId: string, destNodeId: string): Promise<ProposalSchema> {
  const res = await fetch(`/api/backend/workflows/${workflowId}/mappings/propose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ destNodeId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new MappingsApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? res.statusText, body?.error?.details);
  }
  return res.json() as Promise<ProposalSchema>;
}
