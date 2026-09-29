'use server';

import { apiFetchServer, ApiError } from '@/lib/api/server';
import type { ConsoleOrgsPage, ConsoleUsersPage } from '@/lib/api/consoleServer';

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
 * Slice 3e (docs/plans/console-plan.md, build order step 12): ConsoleUsers
 * Client.tsx's search box and "Load more" button both call this — unlike
 * ConsoleDirectoryClient's `search` (a client-side-only filter over the
 * already-loaded page, see its own doc comment), GET /console/users does
 * real server-side search by email/name (the user's own explicit spec), so
 * a search-term change has to re-fetch from offset 0, not just filter what's
 * already in the browser.
 */
export async function searchUsersAction(search: string, offset: number): Promise<ConsoleUsersPage> {
  const query = new URLSearchParams();
  if (search) query.set('search', search);
  if (offset) query.set('offset', String(offset));
  const qs = query.toString();
  return apiFetchServer<ConsoleUsersPage>(`/console/users${qs ? `?${qs}` : ''}`);
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

/**
 * Slice 3b (docs/plans/console-plan.md, decisions 1-2, additions 3-6):
 * submits ConsoleOrgDetailClient's suspend/unsuspend form to
 * POST /console/orgs/:orgId/suspend|unsuspend — same
 * useTransition-driven, non-ActionState shape as updateOrgPlanAction
 * above (a plain confirm-style form, not a <form action>).
 */
export async function suspendOrgAction(
  orgId: string,
  reason: string,
): Promise<
  { ok: true; status: string; suspendedAt: string; suspendedReason: string } | { ok: false; error: string }
> {
  try {
    const result = await apiFetchServer<{ status: string; suspendedAt: string; suspendedReason: string }>(
      `/console/orgs/${encodeURIComponent(orgId)}/suspend`,
      {
        method: 'POST',
        body: JSON.stringify({ reason }),
      },
    );
    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    return { ok: false, error: "Couldn't suspend the organization. Try again." };
  }
}

export async function unsuspendOrgAction(
  orgId: string,
  note: string,
): Promise<{ ok: true; status: string } | { ok: false; error: string }> {
  try {
    const result = await apiFetchServer<{ status: string }>(`/console/orgs/${encodeURIComponent(orgId)}/unsuspend`, {
      method: 'POST',
      body: JSON.stringify({ note: note.trim() ? note : undefined }),
    });
    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    return { ok: false, error: "Couldn't unsuspend the organization. Try again." };
  }
}

/**
 * Slice 3f (docs/plans/console-plan.md, build order step 13, decisions 3-4):
 * submits ConsoleUserDetailClient's "Sign out everywhere" reason +
 * confirmation form to POST /console/users/:userId/revoke-sessions — same
 * useTransition-driven, non-ActionState shape as suspendOrgAction above.
 */
export async function revokeUserSessionsAction(
  userId: string,
  reason: string,
): Promise<{ ok: true; revokedSessionCount: number } | { ok: false; error: string }> {
  try {
    const result = await apiFetchServer<{ revokedSessionCount: number }>(
      `/console/users/${encodeURIComponent(userId)}/revoke-sessions`,
      {
        method: 'POST',
        body: JSON.stringify({ reason }),
      },
    );
    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    return { ok: false, error: "Couldn't sign this user out. Try again." };
  }
}
