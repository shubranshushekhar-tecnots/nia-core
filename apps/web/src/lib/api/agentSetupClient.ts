import type { AgentJobSetup, AgentJobSetupDiff } from '@nia/schemas';
import { ensureBearerToken } from '@/lib/auth/browserSession';

/**
 * Browser-side calls for Slice R4's agent-delivered-job publish flow
 * (apps/api's GET/POST /workflows/:id/agent-setup*, backed by
 * apps/api/src/services/agentSetups.ts and supabase/migrations/
 * 0073_agent_setup_publish.sql's publish_agent_setup/unpublish_agent_setup
 * RPCs). Same auth mode as graphClient.ts/checksClient.ts — Bearer-only
 * (requireAuth), not cookie auth.
 */

export class AgentSetupApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AgentSetupApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await ensureBearerToken();
  if (!token) throw new AgentSetupApiError(401, 'NOT_AUTHENTICATED', 'No active session.');
  return { Authorization: `Bearer ${token}` };
}

async function parseError(res: Response): Promise<never> {
  const body = await res.json().catch(() => null);
  throw new AgentSetupApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? res.statusText, body?.error?.details);
}

export type AgentSetupState = 'unpublished' | 'waiting' | 'applied' | 'rejected';

export type AgentSetupStateResult = {
  state: AgentSetupState;
  wantedVersion: number;
  appliedVersion: number;
  publishedAt: string | null;
  rejectionReason: string | null;
};

/** Read-only, available to viewers — no capability gate on the route. */
export async function getAgentSetupState(workflowId: string): Promise<AgentSetupStateResult> {
  const res = await fetch(`/api/backend/workflows/${workflowId}/agent-setup`, {
    method: 'GET',
    headers: { Accept: 'application/json', ...(await authHeaders()) },
  });
  if (!res.ok) await parseError(res);
  return res.json() as Promise<AgentSetupStateResult>;
}

export type AgentSetupPublishInput = {
  sourceConnectionId: string;
  destinationConnectionId: string;
  setup: AgentJobSetup;
};

export type AgentSetupPreviewResult = {
  diff: AgentJobSetupDiff;
  currentlyPublished: boolean;
};

/** Validates + diffs against the currently published setup — never writes. */
export async function previewPublishAgentSetup(
  workflowId: string,
  input: AgentSetupPublishInput,
): Promise<AgentSetupPreviewResult> {
  const res = await fetch(`/api/backend/workflows/${workflowId}/agent-setup/preview-publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(input),
  });
  if (!res.ok) await parseError(res);
  return res.json() as Promise<AgentSetupPreviewResult>;
}

export type AgentSetupPublication = {
  id: string;
  workflowId: string;
  agentId: string;
  wantedVersion: number;
  appliedVersion: number;
  publishedAt: string | null;
};

export async function publishAgentSetup(
  workflowId: string,
  input: AgentSetupPublishInput,
): Promise<AgentSetupPublication> {
  const res = await fetch(`/api/backend/workflows/${workflowId}/agent-setup/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(input),
  });
  if (!res.ok) await parseError(res);
  return res.json() as Promise<AgentSetupPublication>;
}

/** Soft-unpublish — run history survives (apps/api/src/services/agentSetups.ts). */
export async function unpublishAgentSetup(workflowId: string): Promise<AgentSetupPublication> {
  const res = await fetch(`/api/backend/workflows/${workflowId}/agent-setup/unpublish`, {
    method: 'POST',
    headers: { Accept: 'application/json', ...(await authHeaders()) },
  });
  if (!res.ok) await parseError(res);
  return res.json() as Promise<AgentSetupPublication>;
}
