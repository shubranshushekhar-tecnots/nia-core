'use server';

import { apiFetchServer, ApiError } from '@/lib/api/server';
import {
  getConsoleAuditLogs,
  getConsoleModelPrices,
  getConsoleUsageData,
  type ConsoleAnnouncement,
  type ConsoleAnnouncementsPage,
  type ConsoleAuditLogFilters,
  type ConsoleAuditLogsPage,
  type ConsoleCreateModelPriceInput,
  type ConsoleModelPrice,
  type ConsoleModelPricesPage,
  type ConsoleOrgsPage,
  type ConsolePlanUpdateResult,
  type ConsoleProjectsPage,
  type ConsoleStaffPage,
  type ConsoleUsageData,
  type ConsoleUsageFilters,
  type ConsoleUsersPage,
} from '@/lib/api/consoleServer';

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

/** Console redesign plan's Slice 5 — same "Load more" pattern as loadMoreOrgsAction above. */
export async function loadMoreStaffAction(offset: number): Promise<ConsoleStaffPage> {
  return apiFetchServer<ConsoleStaffPage>(`/console/staff?offset=${offset}`);
}

/** Console redesign plan's Slice 6 — same "Load more" pattern as loadMoreOrgsAction above. */
export async function loadMoreProjectsAction(offset: number): Promise<ConsoleProjectsPage> {
  return apiFetchServer<ConsoleProjectsPage>(`/console/projects?offset=${offset}`);
}

/**
 * Console redesign plan's Slice 7: submits ConsolePlansClient's inline
 * per-plan edit form to PATCH /console/plans/:planId — same
 * useTransition-driven, ok/error mutation shape as updateOrgPlanAction
 * above. Unlike that action, a successful result here carries a
 * `warnings` array (orgs whose current usage already meets/exceeds a
 * lowered limit) that the write still applies — plan.md's "warn, don't
 * block" instruction — so the caller must render `warnings` on success,
 * not treat it as an error.
 */
export async function updatePlanAction(
  planId: string,
  projectLimit: number | null,
  workflowLimit: number | null,
  rowsPerMonth: number | null,
  copilotActionsPerMonth: number | null,
): Promise<({ ok: true } & ConsolePlanUpdateResult) | { ok: false; error: string }> {
  try {
    const result = await apiFetchServer<ConsolePlanUpdateResult>(`/console/plans/${encodeURIComponent(planId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ projectLimit, workflowLimit, rowsPerMonth, copilotActionsPerMonth }),
    });
    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    return { ok: false, error: "Couldn't update the plan. Try again." };
  }
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
 * Slice 3a (docs/plans/console-plan.md), extended for subscription-model
 * Phase 1: submits ConsoleOrgDetailClient's inline plan-edit form to PATCH
 * /console/orgs/:orgId/plan. Called directly from the client component via
 * useTransition (same shape as loadMoreOrgsAction above, not
 * lib/connections/actions.ts's ActionState/FormData pattern) — there's no
 * <form> here, and the caller needs the fresh planId/override values back
 * to update its own local state, not a generic ActionState.
 *
 * `planId` picks the catalog plan; the two `*OverrideSet` flags/values
 * carry the edit form's "Clear override" (set = false) vs. an explicit cap
 * or explicit-unlimited (set = true, value positive or null) — same
 * tri-state shape PATCH /console/orgs/:orgId/plan's body schema expects.
 */
export async function updateOrgPlanAction(
  orgId: string,
  planId: string,
  workflowLimitOverrideSet: boolean,
  workflowLimitOverride: number | null,
  projectLimitOverrideSet: boolean,
  projectLimitOverride: number | null,
): Promise<
  | {
      ok: true;
      planId: string;
      workflowLimitOverrideSet: boolean;
      workflowLimitOverride: number | null;
      projectLimitOverrideSet: boolean;
      projectLimitOverride: number | null;
    }
  | { ok: false; error: string }
> {
  try {
    const result = await apiFetchServer<{
      planId: string;
      workflowLimitOverrideSet: boolean;
      workflowLimitOverride: number | null;
      projectLimitOverrideSet: boolean;
      projectLimitOverride: number | null;
    }>(`/console/orgs/${encodeURIComponent(orgId)}/plan`, {
      method: 'PATCH',
      body: JSON.stringify({
        planId,
        workflowLimitOverrideSet,
        workflowLimitOverride,
        projectLimitOverrideSet,
        projectLimitOverride,
      }),
    });
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

/**
 * Subscription Phase 5, Slice 6 (docs/plans/subscription-model.md, decision
 * 2): submits ConsoleOrgDetailClient's per-member "Remove from org"
 * reason + confirmation form to POST
 * /console/orgs/:orgId/members/:userId/remove — same useTransition-driven,
 * ok/error mutation shape as suspendOrgAction/revokeUserSessionsAction
 * above. The route's own error message (e.g. the last-owner / billing-owner
 * refusal, surfaced verbatim from the DB trigger — see routes/console.ts's
 * doc comment on this route) flows straight through as `error` via
 * ApiError, same "the trigger's own message IS the customer-facing copy"
 * convention used elsewhere.
 */
export async function removeMemberAction(
  orgId: string,
  userId: string,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await apiFetchServer<{ status: string }>(
      `/console/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}/remove`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    );
    return { ok: true };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    return { ok: false, error: "Couldn't remove this member. Try again." };
  }
}

/**
 * Subscription Phase 5, Slice 3 (docs/plans/subscription-model.md, decision
 * 1): ConsoleAnnouncementsClient's tab switch and "Load more" both call
 * this — plain data-fetching Server Action, same non-mutation shape as
 * loadMoreOrgsAction/searchUsersAction above, not the ok/error mutation
 * shape below.
 */
export async function loadAnnouncementsAction(
  status: 'active' | 'scheduled' | 'ended',
  offset: number,
): Promise<ConsoleAnnouncementsPage> {
  const query = new URLSearchParams();
  query.set('status', status);
  if (offset) query.set('offset', String(offset));
  return apiFetchServer<ConsoleAnnouncementsPage>(`/console/announcements?${query.toString()}`);
}

/**
 * Subscription Phase 5, Slice 3: submits ConsoleAnnouncementsClient's
 * create form to POST /console/announcements — same useTransition-driven,
 * ok/error mutation shape as suspendOrgAction above.
 */
export async function createAnnouncementAction(input: {
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'critical';
  audience: 'all' | 'org' | 'project';
  audienceOrgId?: string;
  audienceProjectId?: string;
  audienceRoles?: string[];
  startsAt?: string;
  endsAt?: string;
}): Promise<{ ok: true; announcement: ConsoleAnnouncement } | { ok: false; error: string }> {
  try {
    const announcement = await apiFetchServer<ConsoleAnnouncement>('/console/announcements', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return { ok: true, announcement };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    return { ok: false, error: "Couldn't create the announcement. Try again." };
  }
}

/**
 * Subscription Phase 5, Slice 3: submits an "End now" click to
 * POST /console/announcements/:id/end — same ok/error mutation shape as
 * suspendOrgAction above. No reason required (unlike suspend/revoke): this
 * isn't a destructive customer-facing action, just an early-stop of the
 * staff's own announcement.
 */
export async function endAnnouncementAction(
  id: string,
): Promise<{ ok: true; announcement: ConsoleAnnouncement } | { ok: false; error: string }> {
  try {
    const announcement = await apiFetchServer<ConsoleAnnouncement>(
      `/console/announcements/${encodeURIComponent(id)}/end`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    return { ok: true, announcement };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    return { ok: false, error: "Couldn't end the announcement. Try again." };
  }
}

/**
 * Subscription Phase 5, Slice 3: submits an "Archive" click to
 * POST /console/announcements/:id/archive — same shape as
 * endAnnouncementAction above.
 */
export async function archiveAnnouncementAction(
  id: string,
): Promise<{ ok: true; announcement: ConsoleAnnouncement } | { ok: false; error: string }> {
  try {
    const announcement = await apiFetchServer<ConsoleAnnouncement>(
      `/console/announcements/${encodeURIComponent(id)}/archive`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    return { ok: true, announcement };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    return { ok: false, error: "Couldn't archive the announcement. Try again." };
  }
}

/**
 * Console v2 Slice 5: ConsoleUsageClient.tsx's "Apply filters" button calls
 * this to re-fetch all five usage views (summary/timeseries/byModel/
 * byFeature/topConsumers) for a new filter set — plain data-fetching Server
 * Action, same non-mutation shape as loadMoreOrgsAction/loadAnnouncementsAction
 * above, delegating to consoleServer.ts's getConsoleUsageData so page.tsx's
 * initial load and this reload path can never drift apart.
 */
export async function loadUsageDataAction(filters: ConsoleUsageFilters): Promise<ConsoleUsageData> {
  return getConsoleUsageData(filters);
}

/**
 * Console redesign plan's Slice 8: ConsoleAuditLogsClient.tsx's filter bar
 * ("Apply"/"Reset") and "Load more" button both call this — plain
 * data-fetching Server Action, same non-mutation shape as
 * loadUsageDataAction above, delegating to consoleServer.ts's
 * getConsoleAuditLogs so the initial server-rendered page and every reload/
 * pagination call share one request-building path.
 */
export async function loadAuditLogsAction(
  filters: ConsoleAuditLogFilters,
  offset?: number,
): Promise<ConsoleAuditLogsPage> {
  return getConsoleAuditLogs(filters, offset);
}

/**
 * Console redesign plan's Slice 9: ConsoleModelPricesClient.tsx's "Load
 * more" button and its per-model "View history" toggle both call this —
 * plain data-fetching Server Action, same non-mutation shape as
 * loadAuditLogsAction above, delegating to consoleServer.ts's
 * getConsoleModelPrices so the initial server-rendered page and every
 * reload/pagination/history call share one request-building path.
 */
export async function loadModelPricesAction(params?: {
  history?: string;
  offset?: number;
}): Promise<ConsoleModelPricesPage> {
  return getConsoleModelPrices(params);
}

/**
 * Console redesign plan's Slice 9: submits ConsoleModelPricesClient's
 * "Add price" form to POST /console/model-prices — same useTransition-
 * driven, ok/error mutation shape as updatePlanAction above. `model_prices`
 * is append-only, so this always inserts a new row (a "correction" is just
 * a new row with a later effectiveFrom), never an update.
 */
export async function createModelPriceAction(
  input: ConsoleCreateModelPriceInput,
): Promise<{ ok: true; price: ConsoleModelPrice } | { ok: false; error: string }> {
  try {
    const price = await apiFetchServer<ConsoleModelPrice>('/console/model-prices', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return { ok: true, price };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    return { ok: false, error: "Couldn't add the price. Try again." };
  }
}
