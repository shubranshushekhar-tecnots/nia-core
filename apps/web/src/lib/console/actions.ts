'use server';

import { apiFetchServer, ApiError } from '@/lib/api/server';
import {
  getConsoleAccessRequests,
  getConsoleAuditLogs,
  getConsoleModelPrices,
  getConsolePlatformInvites,
  getConsoleUsageData,
  type ConsoleAccessRequest,
  type ConsoleAccessRequestsPage,
  type ConsoleAnnouncement,
  type ConsoleAnnouncementsPage,
  type ConsoleAuditLogFilters,
  type ConsoleAuditLogsPage,
  type ConsoleCreateModelPriceInput,
  type ConsoleModelPrice,
  type ConsoleModelPricesPage,
  type ConsoleOrgsPage,
  type ConsolePlanOverrideFields,
  type ConsolePlanUpdateResult,
  type ConsolePlatformInvite,
  type ConsolePlatformInvitesPage,
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
 * Slice 3e (docs/plans/console-plan.md, build order step 12), extended for
 * the plan-visibility work: ConsoleUsersClient.tsx's search box, role/
 * plan/workspace-type filter controls, and "Load more" button all call
 * this — unlike ConsoleDirectoryClient's `search` (a client-side-only
 * filter over the already-loaded page, see its own doc comment), GET
 * /console/users does real server-side search + filtering (the user's own
 * explicit spec), so any filter change has to re-fetch from offset 0, not
 * just filter what's already in the browser.
 */
export async function searchUsersAction(
  search: string,
  offset: number,
  filters?: { role?: string; plan?: string; workspaceType?: 'individual' | 'org' },
): Promise<ConsoleUsersPage> {
  const query = new URLSearchParams();
  if (search) query.set('search', search);
  if (filters?.role) query.set('role', filters.role);
  if (filters?.plan) query.set('plan', filters.plan);
  if (filters?.workspaceType) query.set('workspaceType', filters.workspaceType);
  if (offset) query.set('offset', String(offset));
  const qs = query.toString();
  return apiFetchServer<ConsoleUsersPage>(`/console/users${qs ? `?${qs}` : ''}`);
}

/**
 * Slice 3a (docs/plans/console-plan.md), extended for subscription-model
 * Phase 1 and for the plan-visibility work (Copilot/rows overrides,
 * expiry, required reason): submits ConsoleOrgDetailClient's inline
 * plan-edit form to PATCH /console/orgs/:orgId/plan. Called directly from
 * the client component via useTransition (same shape as loadMoreOrgsAction
 * above, not lib/connections/actions.ts's ActionState/FormData pattern) —
 * there's no <form> here, and the caller needs the fresh planId/override
 * values back to update its own local state, not a generic ActionState.
 *
 * `planId` picks the org's permanent BASE plan (never cleared by grant
 * expiry); `workflowLimitOverrideSet/Override` and
 * `projectLimitOverrideSet/Override` are the permanent overrides (0050),
 * each `*OverrideSet` flag/value pair carrying the edit form's "Clear
 * override" (set = false) vs. an explicit cap or explicit-unlimited (set =
 * true, value positive or null). `grantPlanId` (nullable) +
 * `grantCopilotActionsPerMonthOverrideSet/Override` +
 * `grantRowsPerMonthOverrideSet/Override` + `grantExpiresAt` (nullable ISO
 * string) are the staff "grant" — a temporary plan-tier + copilot/rows
 * override, independently expiring back to the base `planId` above (never
 * Free) once `grantExpiresAt` passes. `reason` (required, shown to staff in
 * the audit log) is new; the body/response shape is now identical to
 * `updateUserPlanAction` below (`ConsolePlanOverrideFields`).
 */
export async function updateOrgPlanAction(
  orgId: string,
  planId: string,
  workflowLimitOverrideSet: boolean,
  workflowLimitOverride: number | null,
  projectLimitOverrideSet: boolean,
  projectLimitOverride: number | null,
  grantPlanId: string | null,
  grantCopilotActionsPerMonthOverrideSet: boolean,
  grantCopilotActionsPerMonthOverride: number | null,
  grantRowsPerMonthOverrideSet: boolean,
  grantRowsPerMonthOverride: number | null,
  grantExpiresAt: string | null,
  reason: string,
): Promise<({ ok: true } & ConsolePlanOverrideFields) | { ok: false; error: string }> {
  try {
    const result = await apiFetchServer<ConsolePlanOverrideFields>(`/console/orgs/${encodeURIComponent(orgId)}/plan`, {
      method: 'PATCH',
      body: JSON.stringify({
        planId,
        workflowLimitOverrideSet,
        workflowLimitOverride,
        projectLimitOverrideSet,
        projectLimitOverride,
        grantPlanId,
        grantCopilotActionsPerMonthOverrideSet,
        grantCopilotActionsPerMonthOverride,
        grantRowsPerMonthOverrideSet,
        grantRowsPerMonthOverride,
        grantExpiresAt,
        reason,
      }),
    });
    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    return { ok: false, error: "Couldn't update the plan. Try again." };
  }
}

/**
 * Plan-visibility work: the individual-workspace equivalent of
 * `updateOrgPlanAction` above, submitting ConsoleUserDetailClient's
 * tri-state plan-edit form to PATCH /console/users/:userId/plan — same
 * body/response shape (`ConsolePlanOverrideFields` + required `reason`).
 * The route itself 400s with `USER_IS_ORG_MEMBER` if the target user has
 * any org membership (surfaced verbatim as `error`, same "the route's own
 * message IS the customer-facing copy" convention as suspendOrgAction) —
 * callers should only render this form for `workspaceType === 'individual'`
 * users in the first place (see ConsoleUserDetail.individualPlan).
 */
export async function updateUserPlanAction(
  userId: string,
  planId: string,
  workflowLimitOverrideSet: boolean,
  workflowLimitOverride: number | null,
  projectLimitOverrideSet: boolean,
  projectLimitOverride: number | null,
  grantPlanId: string | null,
  grantCopilotActionsPerMonthOverrideSet: boolean,
  grantCopilotActionsPerMonthOverride: number | null,
  grantRowsPerMonthOverrideSet: boolean,
  grantRowsPerMonthOverride: number | null,
  grantExpiresAt: string | null,
  reason: string,
): Promise<({ ok: true } & ConsolePlanOverrideFields) | { ok: false; error: string }> {
  try {
    const result = await apiFetchServer<ConsolePlanOverrideFields>(`/console/users/${encodeURIComponent(userId)}/plan`, {
      method: 'PATCH',
      body: JSON.stringify({
        planId,
        workflowLimitOverrideSet,
        workflowLimitOverride,
        projectLimitOverrideSet,
        projectLimitOverride,
        grantPlanId,
        grantCopilotActionsPerMonthOverrideSet,
        grantCopilotActionsPerMonthOverride,
        grantRowsPerMonthOverrideSet,
        grantRowsPerMonthOverride,
        grantExpiresAt,
        reason,
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

/**
 * Email Phase 3: ConsoleAccessRequestsClient's status-tab switch and search
 * box both call this — plain data-fetching Server Action, same non-mutation
 * shape as searchUsersAction above, delegating to consoleServer.ts's
 * getConsoleAccessRequests so the initial server-rendered page and every
 * reload/pagination call share one request-building path.
 */
export async function loadAccessRequestsAction(
  status: 'pending' | 'approved' | 'rejected' | undefined,
  search: string,
  offset: number,
): Promise<ConsoleAccessRequestsPage> {
  return getConsoleAccessRequests({ status, search: search || undefined, offset: offset || undefined });
}

/**
 * Email Phase 3: AccessRequestApproveForm's approve submit, calling
 * PATCH /console/access-requests/:id/approve — same useTransition-driven,
 * ok/error mutation shape as updatePlanAction above. `planId` picks the
 * base plan immediately; `grantPlanId`/`grantExpiresAt` are an optional
 * temporary grant, same semantics as updateOrgPlanAction's grant fields.
 */
export async function approveAccessRequestAction(
  id: string,
  planId: string | undefined,
  grantPlanId: string | null,
  grantExpiresAt: string | null,
): Promise<{ ok: true; request: ConsoleAccessRequest } | { ok: false; error: string }> {
  try {
    const request = await apiFetchServer<ConsoleAccessRequest>(`/console/access-requests/${encodeURIComponent(id)}/approve`, {
      method: 'PATCH',
      body: JSON.stringify({ planId, grantPlanId, grantExpiresAt }),
    });
    return { ok: true, request };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    return { ok: false, error: "Couldn't approve this request. Try again." };
  }
}

/**
 * Email Phase 3: AccessRequestApproveForm's reject submit, calling
 * PATCH /console/access-requests/:id/reject — same shape as
 * approveAccessRequestAction above. Also used to re-reject (no status
 * guard on the route) and the route allows re-approving a previously
 * rejected row via approveAccessRequestAction, matching the spec's
 * explicit "re-approve a rejected row" test case.
 */
export async function rejectAccessRequestAction(
  id: string,
  reason: string,
): Promise<{ ok: true; request: ConsoleAccessRequest } | { ok: false; error: string }> {
  try {
    const request = await apiFetchServer<ConsoleAccessRequest>(`/console/access-requests/${encodeURIComponent(id)}/reject`, {
      method: 'PATCH',
      body: JSON.stringify({ reason: reason || undefined }),
    });
    return { ok: true, request };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    return { ok: false, error: "Couldn't reject this request. Try again." };
  }
}

/**
 * Email Phase 3: ConsoleInvitationsClient's status-tab switch and search
 * box both call this — same non-mutation shape as loadAccessRequestsAction
 * above, delegating to consoleServer.ts's getConsolePlatformInvites.
 */
export async function loadPlatformInvitesAction(
  status: 'pending' | 'accepted' | 'revoked' | undefined,
  search: string,
  offset: number,
): Promise<ConsolePlatformInvitesPage> {
  return getConsolePlatformInvites({ status, search: search || undefined, offset: offset || undefined });
}

/**
 * Email Phase 3: ConsoleInvitationsClient's "Invite" create form, calling
 * POST /console/platform-invites — same ok/error mutation shape as
 * createAnnouncementAction above. The route 409s with
 * `INVITE_ALREADY_PENDING` (surfaced verbatim as `error`, same "the
 * route's own message IS the customer-facing copy" convention used
 * elsewhere) if the email already has an active pending invite.
 */
export async function createPlatformInviteAction(input: {
  email: string;
  name?: string;
  planId?: string;
  grantPlanId?: string;
  grantExpiresAt?: string;
  note?: string;
}): Promise<{ ok: true; invite: ConsolePlatformInvite } | { ok: false; error: string }> {
  try {
    const invite = await apiFetchServer<ConsolePlatformInvite>('/console/platform-invites', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return { ok: true, invite };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    return { ok: false, error: "Couldn't create the invite. Try again." };
  }
}

/**
 * Email Phase 3: ConsoleInvitationsClient's per-row "Resend" button, calling
 * POST /console/platform-invites/:id/resend — same shape as
 * createPlatformInviteAction above. Mints a fresh token/link on the same
 * row (see consolePlatformInvites.ts's header comment) and bumps the
 * 7-day expiry.
 */
export async function resendPlatformInviteAction(
  id: string,
): Promise<{ ok: true; invite: ConsolePlatformInvite } | { ok: false; error: string }> {
  try {
    const invite = await apiFetchServer<ConsolePlatformInvite>(
      `/console/platform-invites/${encodeURIComponent(id)}/resend`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    return { ok: true, invite };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    return { ok: false, error: "Couldn't resend this invite. Try again." };
  }
}

/**
 * Email Phase 3: ConsoleInvitationsClient's per-row "Revoke" button, calling
 * POST /console/platform-invites/:id/revoke — same shape as
 * resendPlatformInviteAction above.
 */
export async function revokePlatformInviteAction(
  id: string,
): Promise<{ ok: true; invite: ConsolePlatformInvite } | { ok: false; error: string }> {
  try {
    const invite = await apiFetchServer<ConsolePlatformInvite>(
      `/console/platform-invites/${encodeURIComponent(id)}/revoke`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    return { ok: true, invite };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    return { ok: false, error: "Couldn't revoke this invite. Try again." };
  }
}
