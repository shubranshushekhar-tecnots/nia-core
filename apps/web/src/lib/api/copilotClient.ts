import type { GraphDoc, Plan, PlanProposeOutcome } from '@nia/schemas';
import { createClient } from '@/lib/supabase/client';

/**
 * Browser-side call for Copilot's Apply step (Phase 7 Session 2.2's
 * POST /workflows/:id/plan/apply). Same auth mode as graphClient.ts — this
 * route is mounted under apps/api's Bearer-only requireAuth, not cookie
 * auth, so the access token is attached manually on every call.
 */

export class CopilotApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'CopilotApiError';
    this.status = status;
    this.code = code;
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await createClient().auth.getSession();
  if (!session) throw new CopilotApiError(401, 'NOT_AUTHENTICATED', 'No active session.');
  return { Authorization: `Bearer ${session.access_token}` };
}

export type ApplyPlanResult = { graph: GraphDoc; version: number; appliedNodeIds: string[] };

export type ProposePlanResult = { conversationId: string; outcome: PlanProposeOutcome };

/**
 * Phase 7 Session 3 — Copilot "propose" (POST /workflows/:id/plan). A
 * plain request/response call, not SSE: runPlanPropose resolves in one
 * worker job with no incremental events (see planQueue.ts's header
 * comment), so there's nothing to stream. Every PlanProposeOutcome status
 * (error/no-connection/refused/clarify/ok) comes back as a 200 body the
 * caller must branch on — only genuine infra failure throws
 * CopilotApiError.
 */
export async function proposePlan(
  workflowId: string,
  input: { message: string; conversationId?: string },
): Promise<ProposePlanResult> {
  const res = await fetch(`/api/backend/workflows/${workflowId}/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new CopilotApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? res.statusText);
  }
  return res.json() as Promise<ProposePlanResult>;
}

/**
 * A non-2xx response (most notably 409 PLAN_STALE) means nothing was
 * written — the caller must leave the ghost in place so the user can
 * discard/retry (FlowCanvas.tsx's store only calls clearGhost() after this
 * resolves successfully), matching Apply's documented "failure preserves
 * ghost" contract (Phase 7 plan, 2.2).
 */
export async function applyPlan(workflowId: string, input: { plan: Plan; prompt?: string }): Promise<ApplyPlanResult> {
  const res = await fetch(`/api/backend/workflows/${workflowId}/plan/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new CopilotApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? res.statusText);
  }
  return res.json() as Promise<ApplyPlanResult>;
}
