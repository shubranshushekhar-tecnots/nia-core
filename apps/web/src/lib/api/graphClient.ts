import type { GraphDoc } from '@nia/schemas';
import { createClient } from '@/lib/supabase/client';

/**
 * Browser-side calls for the builder canvas's graph persistence
 * (apps/api's GET/PUT /workflows/:id/graph). Same same-origin-proxy target
 * as chatClient.ts (`/api/backend/:path*`, next.config.mjs rewrite), but a
 * DIFFERENT auth mode: chat routes are cookie-authenticated
 * (requireCookieAuth), while /workflows/:id/graph is mounted under
 * requireAuth (apps/api/src/middleware/auth.ts) — strictly Bearer-only,
 * never reads cookies. So every call here manually attaches the browser
 * Supabase client's current access token as an Authorization header; the
 * rewrite only avoids CORS, it doesn't grant auth by itself.
 */

export class GraphApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'GraphApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await createClient().auth.getSession();
  if (!session) throw new GraphApiError(401, 'NOT_AUTHENTICATED', 'No active session.');
  return { Authorization: `Bearer ${session.access_token}` };
}

export type WorkflowGraphResult = { graph: GraphDoc; version: number };

export async function getWorkflowGraph(workflowId: string): Promise<WorkflowGraphResult> {
  const res = await fetch(`/api/backend/workflows/${workflowId}/graph`, {
    method: 'GET',
    headers: { Accept: 'application/json', ...(await authHeaders()) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new GraphApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? res.statusText, body?.error?.details);
  }
  return res.json() as Promise<WorkflowGraphResult>;
}

/**
 * expectedVersion 0 means "never saved" (the getWorkflowGraph sentinel —
 * see apps/api/src/services/workflowGraphs.ts). A 409 here always means
 * VERSION_CONFLICT: another session saved first. Callers must surface a
 * reload affordance, never silently retry/overwrite (last-write-wins is
 * exactly what optimistic concurrency here is designed to prevent).
 */
export async function putWorkflowGraph(
  workflowId: string,
  input: { graph: GraphDoc; expectedVersion: number },
): Promise<WorkflowGraphResult> {
  const res = await fetch(`/api/backend/workflows/${workflowId}/graph`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new GraphApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? res.statusText, body?.error?.details);
  }
  return res.json() as Promise<WorkflowGraphResult>;
}
