'use server';

import { apiFetchServer, ApiError } from '@/lib/api/server';
import type { ConsoleOrgsPage } from '@/lib/api/consoleServer';

/**
 * Console v1 Slice 1 review fix (docs/plans/console-plan.md decision 10).
 * page.tsx only fetches the first page of GET /console/orgs server-side —
 * this Server Action is what lets ConsoleDirectoryClient.tsx's "Load more"
 * button fetch subsequent pages without a full page navigation. Called
 * directly from a client component's onClick handler, not bound to a
 * <form> — a plain data-fetching Server Action, not a mutation, so it
 * doesn't follow lib/connections/actions.ts's ActionState/FormData shape.
 */
export async function loadMoreOrgsAction(offset: number): Promise<ConsoleOrgsPage> {
  return apiFetchServer<ConsoleOrgsPage>(`/console/orgs?offset=${offset}`);
}

/**
 * Slice 3a (docs/plans/console-plan.md): submits ConsoleOrgDetailClient's
 * inline plan-edit form to PATCH /console/orgs/:orgId/plan. Called directly
 * from the client component via useTransition (same shape as
 * loadMoreOrgsAction above, not lib/connections/actions.ts's ActionState/
 * FormData pattern) — there's no <form> here, just two controlled inputs,
 * and the caller already needs the fresh planTier/workflowLimit values back
 * to update its own local state, not a generic ActionState.
 */
export async function updateOrgPlanAction(
  orgId: string,
  planTier: string,
  workflowLimit: number | null,
): Promise<{ ok: true; planTier: string; workflowLimit: number | null } | { ok: false; error: string }> {
  try {
    const result = await apiFetchServer<{ planTier: string; workflowLimit: number | null }>(
      `/console/orgs/${encodeURIComponent(orgId)}/plan`,
      {
        method: 'PATCH',
        body: JSON.stringify({ planTier, workflowLimit }),
      },
    );
    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    return { ok: false, error: "Couldn't update the plan. Try again." };
  }
}
