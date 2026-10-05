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

/** Slice R5a — the agent's own latest-reported run state for a platform job (apps/api's AgentSetupJobState). */
export type AgentSetupJobState = {
  state: 'ok' | 'failing' | 'paused';
  errorClass: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
};

export type AgentSetupStateResult = {
  state: AgentSetupState;
  wantedVersion: number;
  appliedVersion: number;
  publishedAt: string | null;
  rejectionReason: string | null;
  jobState: AgentSetupJobState | null;
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

/**
 * Slice R5a (docs/plans/agent-canvas-integration.md B.7/B.8) — actions and
 * run history for an agent-delivered workflow
 * (apps/api/src/services/agentSetupActions.ts). Actions are gated server-side
 * by workflows.run (excludes viewer); run history is a plain read, same as
 * getAgentSetupState above.
 */
export type AgentSetupActionKind = 'test' | 'run_now' | 'full_reload' | 'pause' | 'resume' | 'allow_mass_delete';

export type AgentSetupActionInput = {
  kind: AgentSetupActionKind;
  /** run_now only — one-off parameter values for this run. */
  params?: Record<string, string>;
  /** allow_mass_delete only — explicit confirmation the UI must show before sending. */
  confirm?: boolean;
};

export type AgentActionTask = {
  id: string;
  kind: 'run_now' | 'pause' | 'resume' | 'test_job';
  agentSetupId: string;
};

export async function requestAgentSetupAction(workflowId: string, input: AgentSetupActionInput): Promise<AgentActionTask> {
  const res = await fetch(`/api/backend/workflows/${workflowId}/agent-setup/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(input),
  });
  if (!res.ok) await parseError(res);
  return res.json() as Promise<AgentActionTask>;
}

export type AgentSetupRun = {
  id: string;
  runId: string;
  status: 'ok' | 'failed';
  rowsSent: number;
  rowsDeleted: number;
  mode: string | null;
  durationMs: number;
  errorClass: string | null;
  startedAt: string;
  finishedAt: string;
};

/** Last 50 runs — readable by anyone who can see the workflow, viewers included. */
export async function listAgentSetupRuns(workflowId: string): Promise<AgentSetupRun[]> {
  const res = await fetch(`/api/backend/workflows/${workflowId}/agent-setup/runs`, {
    method: 'GET',
    headers: { Accept: 'application/json', ...(await authHeaders()) },
  });
  if (!res.ok) await parseError(res);
  return res.json() as Promise<AgentSetupRun[]>;
}
