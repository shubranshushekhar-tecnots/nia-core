import type { CheckResult } from '@nia/schemas';
import { createClient } from '@/lib/supabase/client';

/**
 * Browser-side calls for the builder canvas's check-run engine
 * (apps/api's POST /workflows/:id/checks + GET /workflows/:id/checks/latest).
 * Same auth mode as graphClient.ts — Bearer-only (requireAuth), not cookie
 * auth — so every call attaches the browser Supabase client's current access
 * token manually.
 */

export class ChecksApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ChecksApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await createClient().auth.getSession();
  if (!session) throw new ChecksApiError(401, 'NOT_AUTHENTICATED', 'No active session.');
  return { Authorization: `Bearer ${session.access_token}` };
}

export type WorkflowCheckRun = {
  id: string;
  workflowId: string;
  graphVersion: number;
  results: CheckResult[];
  ranAt: string;
};

/**
 * Runs the full check suite (POST) — blocks on the worker's BullMQ job (see
 * apps/api/src/lib/checksQueue.ts), so this can take several seconds; callers
 * must show a running/pending state rather than treating this like a normal
 * fast mutation.
 */
export async function runWorkflowChecks(workflowId: string): Promise<WorkflowCheckRun> {
  const res = await fetch(`/api/backend/workflows/${workflowId}/checks`, {
    method: 'POST',
    headers: { Accept: 'application/json', ...(await authHeaders()) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ChecksApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? res.statusText, body?.error?.details);
  }
  return res.json() as Promise<WorkflowCheckRun>;
}

/** Reads back the latest persisted check run without re-running anything. */
export async function getLatestCheckRun(workflowId: string): Promise<WorkflowCheckRun | null> {
  const res = await fetch(`/api/backend/workflows/${workflowId}/checks/latest`, {
    method: 'GET',
    headers: { Accept: 'application/json', ...(await authHeaders()) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ChecksApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? res.statusText, body?.error?.details);
  }
  return res.json() as Promise<WorkflowCheckRun | null>;
}

/** Full check-run history (newest first) — the Logs tab's check source (Phase 5 Session 4). */
export async function listCheckRuns(workflowId: string): Promise<WorkflowCheckRun[]> {
  const res = await fetch(`/api/backend/workflows/${workflowId}/checks`, {
    method: 'GET',
    headers: { Accept: 'application/json', ...(await authHeaders()) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ChecksApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? res.statusText, body?.error?.details);
  }
  return res.json() as Promise<WorkflowCheckRun[]>;
}
