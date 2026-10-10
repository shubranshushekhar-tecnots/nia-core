import { apiFetchServer } from './server';

/**
 * Console v1 (docs/plans/console-plan.md), Slice 1. Thin wrappers over
 * apiFetchServer for apps/api's /console/* routes — same pattern as every
 * other lib/api/*Server.ts file (e.g. connectionsServer.ts).
 */

export type ConsoleOrg = {
  id: string;
  name: string;
  slug: string;
  planTier: string;
  status: string;
  memberCount: number;
  runs30d: number;
  createdAt: string;
};

/**
 * GET /console/orgs's response shape (Slice 1 review fix, console-plan.md
 * decision 10): always carries `total`/`hasMore` alongside the page of
 * `orgs` actually returned — the Directory screen must never silently
 * truncate a result set with no indication more exists.
 */
export type ConsoleOrgsPage = {
  orgs: ConsoleOrg[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

/**
 * Hits GET /console/ping. Resolves if the caller is staff and the console
 * flag is on; throws ApiError (403 NOT_STAFF, or 404 if the route isn't
 * mounted at all) otherwise. Callers should treat any thrown ApiError as
 * "render notFound()" — see app/console/layout.tsx.
 */
export async function pingConsole(): Promise<void> {
  await apiFetchServer<{ status: string }>('/console/ping');
}

export async function getConsoleOrgs(): Promise<ConsoleOrgsPage> {
  return apiFetchServer<ConsoleOrgsPage>('/console/orgs');
}

export type ConsoleOrgMember = {
  userId: string;
  name: string;
  email: string;
  role: string;
  joinedAt: string;
};

/**
 * GET /console/orgs/:orgId's response shape (Slice 2, console-plan.md build
 * order steps 6-7; extended for subscription-model Phase 1 and 0078's grant
 * redesign). `planId`/`planTier` are the org's permanent BASE plan
 * (org_plan.plan_id, written only by apply_subscription_webhook/signup
 * defaults — never cleared by a grant's expiry). `effectivePlanId`/
 * `effectivePlanTier` are what `private.effective_plan()` actually resolves
 * to right now: the grant's plan while `grantExpiresAt` is null or in the
 * future, otherwise identical to the base plan above (never a hardcoded
 * Free). `workflowLimit`/`projectLimit`/`rowsLimit`/`copilotLimit` are
 * always the *effective* values (private.effective_plan()'s output) —
 * `null` means genuinely unlimited. `workflowLimitOverrideSet/Override` and
 * `projectLimitOverrideSet/Override` are the **permanent** overrides
 * (migration 0050, untouched by any grant/expiry concept). `grantPlanId`
 * (nullable) plus `grantCopilotActionsPerMonthOverrideSet/Override` and
 * `grantRowsPerMonthOverrideSet/Override` are the staff "grant" — a
 * temporary plan-tier + copilot/rows override active only while
 * `grantExpiresAt` is null or in the future; once past, `grantExpired` is
 * `true` and the effective fields above have already reverted to the base
 * plan (never Free) server-side. `grantReason` is the staff note stored
 * with the grant. `status`/`runs30d` mirror ConsoleOrg's fields above (same
 * hardcoded-'Active'/real-count semantics) so the detail screen's header
 * meta line can reuse the Directory screen's exact "{plan} · {N} people ·
 * {M} runs in 30 days · {status}" format. `rowsUsed`/`copilotUsed`
 * (Subscription Phase 3, Slice 5) are display-only, current-calendar-month
 * usage.
 */
export type ConsoleOrgDetail = {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  planId: string;
  planTier: string;
  effectivePlanId: string;
  effectivePlanTier: string;
  status: string;
  suspendedAt: string | null;
  suspendedReason: string | null;
  suspendedBy: { userId: string; name: string | null } | null;
  workflowLimit: number | null;
  workflowLimitOverrideSet: boolean;
  workflowLimitOverride: number | null;
  workflowsUsed: number;
  projectLimit: number | null;
  projectLimitOverrideSet: boolean;
  projectLimitOverride: number | null;
  projectsUsed: number;
  rowsLimit: number | null;
  rowsUsed: number;
  copilotLimit: number | null;
  copilotUsed: number;
  grantPlanId: string | null;
  grantRowsPerMonthOverrideSet: boolean;
  grantRowsPerMonthOverride: number | null;
  grantCopilotActionsPerMonthOverrideSet: boolean;
  grantCopilotActionsPerMonthOverride: number | null;
  grantExpiresAt: string | null;
  grantReason: string | null;
  grantExpired: boolean;
  runs30d: number;
  members: ConsoleOrgMember[];
};

/**
 * Shared tri-state-override request/response shape for both
 * `PATCH /console/orgs/:orgId/plan` and `PATCH /console/users/:userId/plan`
 * (apps/api/src/routes/console.ts, mirrored exactly — the two routes use
 * byte-identical body/response shapes). `planId` is the BASE plan (never
 * cleared by grant expiry); `grantPlanId` + the two `grant*OverrideSet/
 * Override` pairs + `grantExpiresAt` are the staff "grant" — see
 * `ConsoleOrgDetail`'s doc comment above for the full semantics. `reason`
 * is only present on the request side (required by both routes, never
 * echoed back).
 */
export type ConsolePlanOverrideFields = {
  planId: string;
  workflowLimitOverrideSet: boolean;
  workflowLimitOverride: number | null;
  projectLimitOverrideSet: boolean;
  projectLimitOverride: number | null;
  grantPlanId: string | null;
  grantCopilotActionsPerMonthOverrideSet: boolean;
  grantCopilotActionsPerMonthOverride: number | null;
  grantRowsPerMonthOverrideSet: boolean;
  grantRowsPerMonthOverride: number | null;
  grantExpiresAt: string | null;
};

export async function getConsoleOrg(orgId: string): Promise<ConsoleOrgDetail> {
  return apiFetchServer<ConsoleOrgDetail>(`/console/orgs/${encodeURIComponent(orgId)}`);
}

/**
 * GET /console/plans's response shape (subscription-model Phase 1) — the
 * full plan catalog (0049_plans_table.sql), for the Org Detail edit-plan
 * form's dropdown. `null` limit fields mean unlimited, same semantics as
 * everywhere else in this file.
 */
export type ConsolePlan = {
  id: string;
  name: string;
  projectLimit: number | null;
  workflowLimit: number | null;
  rowsPerMonth: number | null;
  copilotActionsPerMonth: number | null;
};

export async function getConsolePlans(): Promise<{ plans: ConsolePlan[] }> {
  return apiFetchServer<{ plans: ConsolePlan[] }>('/console/plans');
}

/**
 * Console redesign plan's Slice 7 — types + wrapper for
 * PATCH /console/plans/:planId (apps/api/src/routes/console.ts, mirrored
 * exactly). Platform-wide catalog edit, not org-scoped — "warn, don't
 * block": `warnings` can be non-empty even though the write still
 * succeeded.
 */
export type ConsolePlanUpdateWarning = {
  orgId: string;
  orgName: string;
  limit: string;
  currentUsage: number;
  newLimit: number;
};

export type ConsolePlanUpdateResult = {
  projectLimit: number | null;
  workflowLimit: number | null;
  rowsPerMonth: number | null;
  copilotActionsPerMonth: number | null;
  warnings: ConsolePlanUpdateWarning[];
};

/**
 * GET /console/orgs/:orgId/runs's response shape (Slice 3c, console-plan.md
 * decision 9). Metadata + error only — never result-row/customer data, same
 * boundary the migration and route doc comments state. `error` is null for
 * any run that hasn't failed, or a pre-migration failed run. Small fix
 * (2026-09-29): `error` gained a `code` alongside `message`, which is now
 * sanitizeRunError()'s output (apps/api/src/lib/sanitizeRunError.ts) — a
 * raw destination-write failure's customer row value is stripped before it
 * ever reaches this route's response.
 */
export type ConsoleRun = {
  id: string;
  workflowId: string;
  status: string;
  error: { code: string; message: string } | null;
  rowsProcessed: number;
  durationMs: number | null;
  startedAt: string;
  finishedAt: string | null;
};

export async function getConsoleOrgRuns(orgId: string): Promise<{ runs: ConsoleRun[] }> {
  return apiFetchServer<{ runs: ConsoleRun[] }>(`/console/orgs/${encodeURIComponent(orgId)}/runs`);
}

/**
 * GET /console/orgs/:orgId/connectors's response shape (Slice 3d,
 * console-plan.md §3/§5a step 11). Health metadata only — type, display
 * name, last-test result, created date — never `config`/`vault_secret_ref`
 * (see routes/console.ts's own doc comment on this route's explicit
 * SELECT/response allowlist). `lastTestStatus`/`lastTestLatencyMs`/
 * `lastTestAt` are all `null` together for a connection that's never been
 * tested.
 */
export type ConsoleConnector = {
  id: string;
  connectorId: string;
  displayName: string;
  lastTestStatus: 'ok' | 'error' | null;
  lastTestLatencyMs: number | null;
  lastTestAt: string | null;
  createdAt: string;
};

export async function getConsoleOrgConnectors(orgId: string): Promise<{ connectors: ConsoleConnector[] }> {
  return apiFetchServer<{ connectors: ConsoleConnector[] }>(`/console/orgs/${encodeURIComponent(orgId)}/connectors`);
}

/**
 * GET /console/users's response shape (Slice 3e, console-plan.md build
 * order step 12; extended for the plan-visibility work). `orgCount` mirrors
 * `ConsoleOrg.memberCount`'s role: useful list context, not a detail field.
 * `orgs` is each membership's `{orgId, orgName, role, planId}`, ordered
 * oldest-first (same array `GET /users/:userId`'s `memberships` carries,
 * just without `joinedAt`). `workspaceType` is `'org'` if `orgCount > 0`,
 * else `'individual'`; `effectiveRole`/`effectivePlanId` mirror the first
 * (oldest) org membership's role/plan when `workspaceType === 'org'`, or
 * `'individual'`/the user's own `owner_plan` plan id otherwise — the same
 * derivation the `role`/`plan`/`workspaceType` filter params below compare
 * against server-side. Same `total`/`limit`/`offset`/`hasMore` paging shape
 * as `ConsoleOrgsPage` (decision 10's "never silently truncate" rule
 * applies identically here).
 */
export type ConsoleUserOrgMembership = {
  orgId: string;
  orgName: string;
  role: string;
  planId: string;
};

export type ConsoleUser = {
  id: string;
  name: string;
  email: string;
  orgCount: number;
  createdAt: string;
  orgs: ConsoleUserOrgMembership[];
  workspaceType: 'individual' | 'org';
  effectivePlanId: string;
  effectiveRole: string;
};

export type ConsoleUsersPage = {
  users: ConsoleUser[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export async function getConsoleUsers(params?: {
  search?: string;
  role?: string;
  plan?: string;
  workspaceType?: 'individual' | 'org';
  offset?: number;
}): Promise<ConsoleUsersPage> {
  const query = new URLSearchParams();
  if (params?.search) query.set('search', params.search);
  if (params?.role) query.set('role', params.role);
  if (params?.plan) query.set('plan', params.plan);
  if (params?.workspaceType) query.set('workspaceType', params.workspaceType);
  if (params?.offset) query.set('offset', String(params.offset));
  const qs = query.toString();
  return apiFetchServer<ConsoleUsersPage>(`/console/users${qs ? `?${qs}` : ''}`);
}

/**
 * GET /console/users/:userId's response shape (Slice 3e, extended for the
 * plan-visibility work). Profile, org memberships (with role + effective
 * plan id), and session count/last-sign-in metadata only — never a
 * password, token, or 2FA-secret field, per routes/console.ts's own doc
 * comment on this route's explicit SELECT/response allowlist.
 *
 * `workspaceType` is `'org'` when `memberships.length > 0`, else
 * `'individual'`. `individualPlan` is non-null only in the `'individual'`
 * case — it's the owner_plan-backed equivalent of `ConsoleOrgDetail`'s
 * plan/override block (same field names, no `planTier`/usage counters since
 * there's no catalog display name lookup or usage rollup for individual
 * workspaces yet). An org-member user always has `individualPlan: null`;
 * edit their plan on `/console/orgs/[orgId]` instead (see `orgs`/
 * `memberships` for the link target).
 */
export type ConsoleUserMembership = {
  orgId: string;
  orgName: string;
  role: string;
  joinedAt: string;
  planId: string;
};

export type ConsoleIndividualPlan = {
  planId: string;
  planName: string;
  effectivePlanId: string;
  effectivePlanName: string;
  workflowLimit: number | null;
  projectLimit: number | null;
  copilotLimit: number | null;
  rowsLimit: number | null;
  workflowLimitOverrideSet: boolean;
  workflowLimitOverride: number | null;
  projectLimitOverrideSet: boolean;
  projectLimitOverride: number | null;
  grantPlanId: string | null;
  grantCopilotActionsPerMonthOverrideSet: boolean;
  grantCopilotActionsPerMonthOverride: number | null;
  grantRowsPerMonthOverrideSet: boolean;
  grantRowsPerMonthOverride: number | null;
  grantExpiresAt: string | null;
  grantReason: string | null;
  grantExpired: boolean;
};

export type ConsoleUserDetail = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: string;
  workspaceType: 'individual' | 'org';
  memberships: ConsoleUserMembership[];
  individualPlan: ConsoleIndividualPlan | null;
  sessionCount: number;
  lastSignInAt: string | null;
};

export async function getConsoleUser(userId: string): Promise<ConsoleUserDetail> {
  return apiFetchServer<ConsoleUserDetail>(`/console/users/${encodeURIComponent(userId)}`);
}

/**
 * Subscription Phase 5, Slice 3 (docs/plans/subscription-model.md, decision
 * 1): GET /console/announcements's response shape. `status` is computed on
 * read by the API (never stored) — 'ended' covers both a naturally-expired
 * (ends_at passed) and a manually archived announcement, same three-tab
 * split (active/scheduled/ended) the Console screen uses.
 */
export type ConsoleAnnouncement = {
  id: string;
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'critical';
  audience: 'all' | 'org' | 'project';
  audienceOrgId: string | null;
  audienceProjectId: string | null;
  audienceRoles: string[] | null;
  startsAt: string;
  endsAt: string | null;
  archivedAt: string | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  status: 'active' | 'scheduled' | 'ended';
};

export type ConsoleAnnouncementsPage = {
  announcements: ConsoleAnnouncement[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export async function getConsoleAnnouncements(params?: {
  status?: 'active' | 'scheduled' | 'ended';
  offset?: number;
}): Promise<ConsoleAnnouncementsPage> {
  const query = new URLSearchParams();
  if (params?.status) query.set('status', params.status);
  if (params?.offset) query.set('offset', String(params.offset));
  const qs = query.toString();
  return apiFetchServer<ConsoleAnnouncementsPage>(`/console/announcements${qs ? `?${qs}` : ''}`);
}

/**
 * Console v2 Slice 5 (docs for Slice 4's apps/api/src/services/usage.ts):
 * types + wrappers mirroring that file's own types exactly, for the token
 * usage page's filters/summary/charts/breakdowns/top-consumers. `dateFrom`/
 * `dateTo` are ISO datetime strings (the route validates with
 * z.string().datetime({ offset: true })).
 */
export type ConsoleUsageFilters = {
  dateFrom?: string;
  dateTo?: string;
  orgId?: string;
  model?: string;
  feature?: string;
};

export type ConsoleUsagePeriodStats = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  callCount: number;
  cost: number;
};

export type ConsoleUsageSummary = {
  today: ConsoleUsagePeriodStats;
  month: ConsoleUsagePeriodStats;
};

export type ConsoleUsageTimeseriesPoint = {
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
};

export type ConsoleUsageBreakdownDimension = 'org' | 'user' | 'model' | 'feature';

export type ConsoleUsageBreakdownRow = {
  key: string;
  label: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  callCount: number;
  cost: number;
};

export type ConsoleUsageTopConsumers = {
  topOrgs: ConsoleUsageBreakdownRow[];
  topUsers: ConsoleUsageBreakdownRow[];
};

function usageFiltersQuery(filters: ConsoleUsageFilters): URLSearchParams {
  const query = new URLSearchParams();
  if (filters.dateFrom) query.set('dateFrom', filters.dateFrom);
  if (filters.dateTo) query.set('dateTo', filters.dateTo);
  if (filters.orgId) query.set('orgId', filters.orgId);
  if (filters.model) query.set('model', filters.model);
  if (filters.feature) query.set('feature', filters.feature);
  return query;
}

export async function getConsoleUsageSummary(orgId?: string): Promise<ConsoleUsageSummary> {
  const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : '';
  return apiFetchServer<ConsoleUsageSummary>(`/console/usage/summary${qs}`);
}

export async function getConsoleUsageTimeseries(filters: ConsoleUsageFilters = {}): Promise<ConsoleUsageTimeseriesPoint[]> {
  const qs = usageFiltersQuery(filters).toString();
  const { points } = await apiFetchServer<{ points: ConsoleUsageTimeseriesPoint[] }>(
    `/console/usage/timeseries${qs ? `?${qs}` : ''}`,
  );
  return points;
}

export async function getConsoleUsageBreakdown(
  by: ConsoleUsageBreakdownDimension,
  filters: ConsoleUsageFilters = {},
  limit?: number,
): Promise<ConsoleUsageBreakdownRow[]> {
  const query = usageFiltersQuery(filters);
  query.set('by', by);
  if (limit) query.set('limit', String(limit));
  const { rows } = await apiFetchServer<{ rows: ConsoleUsageBreakdownRow[] }>(`/console/usage/breakdown?${query.toString()}`);
  return rows;
}

export async function getConsoleUsageTopConsumers(
  filters: ConsoleUsageFilters = {},
  limit?: number,
): Promise<ConsoleUsageTopConsumers> {
  const query = usageFiltersQuery(filters);
  if (limit) query.set('limit', String(limit));
  const qs = query.toString();
  return apiFetchServer<ConsoleUsageTopConsumers>(`/console/usage/top-consumers${qs ? `?${qs}` : ''}`);
}

export type ConsoleUsageData = {
  summary: ConsoleUsageSummary;
  timeseries: ConsoleUsageTimeseriesPoint[];
  byModel: ConsoleUsageBreakdownRow[];
  byFeature: ConsoleUsageBreakdownRow[];
  topConsumers: ConsoleUsageTopConsumers;
};

/**
 * Combined fetch backing both usage/page.tsx's initial load and
 * loadUsageDataAction's filter-change reload (lib/console/actions.ts) — one
 * place for this 5-endpoint composition so the two callers can't drift.
 */
export async function getConsoleUsageData(filters: ConsoleUsageFilters): Promise<ConsoleUsageData> {
  const [summary, timeseries, byModel, byFeature, topConsumers] = await Promise.all([
    getConsoleUsageSummary(filters.orgId),
    getConsoleUsageTimeseries(filters),
    getConsoleUsageBreakdown('model', filters, 50),
    getConsoleUsageBreakdown('feature', filters, 50),
    getConsoleUsageTopConsumers(filters, 10),
  ]);
  return { summary, timeseries, byModel, byFeature, topConsumers };
}

/**
 * Console v2 Slice 6 — types + wrappers for the platform dashboard home
 * screen (apps/api/src/services/consoleDashboard.ts, mirrored exactly).
 * Tokens + cost reuse Slice 5's existing ConsoleUsageSummary/
 * ConsoleUsageTimeseriesPoint directly (no new type needed) — see
 * getConsoleDashboardData below.
 */
export type ConsoleDashboardOverview = {
  totalOrgs: number;
  totalUsers: number;
  activeUsers30d: number;
};

export async function getConsoleDashboardOverview(): Promise<ConsoleDashboardOverview> {
  return apiFetchServer<ConsoleDashboardOverview>('/console/dashboard/overview');
}

export type ConsoleRunsPerDayPoint = {
  date: string;
  succeeded: number;
  failed: number;
  running: number;
  rowsProcessed: number;
};

export async function getConsoleRunsPerDay(days?: number): Promise<ConsoleRunsPerDayPoint[]> {
  const qs = days ? `?days=${encodeURIComponent(String(days))}` : '';
  const { points } = await apiFetchServer<{ points: ConsoleRunsPerDayPoint[] }>(`/console/dashboard/runs-per-day${qs}`);
  return points;
}

export type ConsoleRowsMovedTotals = {
  allTime: number;
  last30d: number;
};

export async function getConsoleRowsMoved(): Promise<ConsoleRowsMovedTotals> {
  return apiFetchServer<ConsoleRowsMovedTotals>('/console/dashboard/rows-moved');
}

export type ConsoleNeedsAttentionReason = 'suspended' | 'near_limit' | 'failing_runs';

export type ConsoleNeedsAttentionItem = {
  orgId: string;
  orgName: string;
  reason: ConsoleNeedsAttentionReason;
  detail: string;
};

export async function getConsoleNeedsAttention(limit?: number): Promise<ConsoleNeedsAttentionItem[]> {
  const qs = limit ? `?limit=${encodeURIComponent(String(limit))}` : '';
  const { items } = await apiFetchServer<{ items: ConsoleNeedsAttentionItem[] }>(`/console/dashboard/needs-attention${qs}`);
  return items;
}

export type ConsoleDashboardData = {
  overview: ConsoleDashboardOverview;
  runsPerDay: ConsoleRunsPerDayPoint[];
  rowsMoved: ConsoleRowsMovedTotals;
  needsAttention: ConsoleNeedsAttentionItem[];
  usageSummary: ConsoleUsageSummary;
  usageTimeseries: ConsoleUsageTimeseriesPoint[];
};

/** Combined fetch backing dashboard/page.tsx's initial load — one place for this 6-endpoint composition. */
export async function getConsoleDashboardData(): Promise<ConsoleDashboardData> {
  const [overview, runsPerDay, rowsMoved, needsAttention, usageSummary, usageTimeseries] = await Promise.all([
    getConsoleDashboardOverview(),
    getConsoleRunsPerDay(30),
    getConsoleRowsMoved(),
    getConsoleNeedsAttention(10),
    getConsoleUsageSummary(),
    getConsoleUsageTimeseries(),
  ]);
  return { overview, runsPerDay, rowsMoved, needsAttention, usageSummary, usageTimeseries };
}

/**
 * Console redesign plan's Slice 4 — types + wrapper for the System Health
 * screen (apps/api/src/services/consoleHealth.ts, mirrored exactly).
 */
export type ConsoleWorkerStatus = {
  status: 'healthy' | 'no_workers';
  count: number;
};

export type ConsoleQueueBacklog = {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
};

export type ConsoleConnectorHealthSummary = {
  ok: number;
  error: number;
  untested: number;
};

export type ConsoleLatestMigration = {
  version: string;
  name: string;
  finishedAt: string;
} | null;

export type ConsoleSystemHealth = {
  api: 'ok';
  worker: ConsoleWorkerStatus;
  queues: ConsoleQueueBacklog[];
  failedRuns24h: number;
  connectors: ConsoleConnectorHealthSummary;
  latestMigration: ConsoleLatestMigration;
};

export async function getConsoleHealth(): Promise<ConsoleSystemHealth> {
  return apiFetchServer<ConsoleSystemHealth>('/console/health');
}

/**
 * Console redesign plan's Slice 5 — types + wrapper for the Platform Staff
 * screen (apps/api/src/routes/consoleStaff.ts, mirrored exactly). Read-only:
 * staff are granted/revoked via the manageStaff.ts CLI only.
 */
export type ConsoleStaffMember = {
  userId: string;
  name: string;
  email: string;
  twoFactorEnabled: boolean;
  grantedBy: { name: string; email: string };
  grantedAt: string;
  lastSignInAt: string | null;
};

export type ConsoleStaffPage = {
  staff: ConsoleStaffMember[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export async function getConsoleStaff(params?: { offset?: number }): Promise<ConsoleStaffPage> {
  const query = new URLSearchParams();
  if (params?.offset) query.set('offset', String(params.offset));
  const qs = query.toString();
  return apiFetchServer<ConsoleStaffPage>(`/console/staff${qs ? `?${qs}` : ''}`);
}

/**
 * Console redesign plan's Slice 6 — types + wrapper for the Projects &
 * Workflows screen (apps/api/src/routes/consoleProjects.ts, mirrored
 * exactly). Per-org rollup only — no workflow content or row data.
 */
export type ConsoleProjectsLastRun = {
  status: string;
  startedAt: string;
} | null;

export type ConsoleProjectsOrgRollup = {
  orgId: string;
  orgName: string;
  projectCount: number;
  workflowCount: number;
  lastRun: ConsoleProjectsLastRun;
};

export type ConsoleProjectsPage = {
  orgs: ConsoleProjectsOrgRollup[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export async function getConsoleProjects(params?: { offset?: number }): Promise<ConsoleProjectsPage> {
  const query = new URLSearchParams();
  if (params?.offset) query.set('offset', String(params.offset));
  const qs = query.toString();
  return apiFetchServer<ConsoleProjectsPage>(`/console/projects${qs ? `?${qs}` : ''}`);
}

/**
 * Console redesign plan's Slice 8 — types + wrapper for the Audit Logs
 * screen (apps/api/src/routes/consoleAuditLogs.ts, mirrored exactly). Each
 * row is tagged with its source table ('staff' for staff_audit_log, 'org'
 * for audit_log) since the two feeds are unioned server-side.
 */
export type ConsoleAuditLogFilters = {
  dateFrom?: string;
  dateTo?: string;
  orgId?: string;
  staffUserId?: string;
  action?: string;
};

export type ConsoleAuditLogEntry = {
  source: 'staff' | 'org';
  id: string;
  createdAt: string;
  action: string;
  orgId: string | null;
  orgName: string | null;
  actorId: string | null;
  actorName: string | null;
  detail: unknown;
};

export type ConsoleAuditLogsPage = {
  items: ConsoleAuditLogEntry[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

function auditLogFiltersQuery(filters: ConsoleAuditLogFilters): URLSearchParams {
  const query = new URLSearchParams();
  if (filters.dateFrom) query.set('dateFrom', filters.dateFrom);
  if (filters.dateTo) query.set('dateTo', filters.dateTo);
  if (filters.orgId) query.set('orgId', filters.orgId);
  if (filters.staffUserId) query.set('staffUserId', filters.staffUserId);
  if (filters.action) query.set('action', filters.action);
  return query;
}

export async function getConsoleAuditLogs(
  filters: ConsoleAuditLogFilters = {},
  offset?: number,
): Promise<ConsoleAuditLogsPage> {
  const query = auditLogFiltersQuery(filters);
  if (offset) query.set('offset', String(offset));
  const qs = query.toString();
  return apiFetchServer<ConsoleAuditLogsPage>(`/console/audit-logs${qs ? `?${qs}` : ''}`);
}

/**
 * Console redesign plan's Slice 9 — types + wrapper for the Model Prices
 * screen (apps/api/src/services/usage.ts's ModelPrice/ModelPricesPage,
 * mirrored exactly). `public.model_prices` is append-only — GET's default
 * page is the latest row per model; `?history=<model>` returns that one
 * model's full price history instead (see getConsoleModelPrices below).
 */
export type ConsoleModelPrice = {
  id: string;
  model: string;
  inputPricePer1m: number;
  outputPricePer1m: number;
  cachedPricePer1m: number | null;
  currency: string;
  effectiveFrom: string;
  createdBy: string | null;
  createdAt: string;
};

export type ConsoleModelPricesPage = {
  items: ConsoleModelPrice[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export async function getConsoleModelPrices(params?: {
  history?: string;
  offset?: number;
}): Promise<ConsoleModelPricesPage> {
  const query = new URLSearchParams();
  if (params?.history) query.set('history', params.history);
  if (params?.offset) query.set('offset', String(params.offset));
  const qs = query.toString();
  return apiFetchServer<ConsoleModelPricesPage>(`/console/model-prices${qs ? `?${qs}` : ''}`);
}

export type ConsoleCreateModelPriceInput = {
  model: string;
  inputPricePer1m: number;
  outputPricePer1m: number;
  cachedPricePer1m?: number;
  currency?: string;
  effectiveFrom?: string;
};

/**
 * Email Phase 3 — types + wrappers for GET/PATCH /console/access-requests
 * (apps/api/src/routes/consoleAccessRequests.ts, mirrored exactly). Backs
 * the "Access requests" console screen's review queue for the public
 * /request-access form.
 */
export type ConsoleAccessRequest = {
  id: string;
  email: string;
  fullName: string;
  company: string;
  jobRole: string | null;
  useCase: string;
  dataSources: string[];
  referralSource: string | null;
  status: 'pending' | 'approved' | 'rejected';
  rejectedReason: string | null;
  planId: string | null;
  grantPlanId: string | null;
  grantExpiresAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  signedUpUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ConsoleAccessRequestsPage = {
  items: ConsoleAccessRequest[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export async function getConsoleAccessRequests(params?: {
  status?: 'pending' | 'approved' | 'rejected';
  search?: string;
  offset?: number;
}): Promise<ConsoleAccessRequestsPage> {
  const query = new URLSearchParams();
  if (params?.status) query.set('status', params.status);
  if (params?.search) query.set('search', params.search);
  if (params?.offset) query.set('offset', String(params.offset));
  const qs = query.toString();
  return apiFetchServer<ConsoleAccessRequestsPage>(`/console/access-requests${qs ? `?${qs}` : ''}`);
}

export async function getConsoleAccessRequest(id: string): Promise<ConsoleAccessRequest> {
  return apiFetchServer<ConsoleAccessRequest>(`/console/access-requests/${encodeURIComponent(id)}`);
}

// Backs ConsoleShell's nav badge — deliberately a separate endpoint from
// getConsoleAccessRequests above, which writes an audit-log row per call
// (see consoleAccessRequests.ts's pending-count route comment).
export async function getConsolePendingAccessRequestCount(): Promise<number> {
  const { count } = await apiFetchServer<{ count: number }>('/console/access-requests/pending-count');
  return count;
}

/**
 * Email Phase 3 — types + wrappers for GET/POST /console/platform-invites
 * (apps/api/src/routes/consolePlatformInvites.ts, mirrored exactly). Backs
 * the "Invitations" console screen (staff-initiated direct platform
 * invites, distinct from org-scoped invite_links). `expired` is computed
 * server-side at read time, not stored.
 */
export type ConsolePlatformInvite = {
  id: string;
  email: string;
  name: string | null;
  status: 'pending' | 'accepted' | 'revoked';
  expired: boolean;
  note: string | null;
  planId: string | null;
  grantPlanId: string | null;
  grantExpiresAt: string | null;
  invitedBy: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ConsolePlatformInvitesPage = {
  items: ConsolePlatformInvite[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export async function getConsolePlatformInvites(params?: {
  status?: 'pending' | 'accepted' | 'revoked';
  search?: string;
  offset?: number;
}): Promise<ConsolePlatformInvitesPage> {
  const query = new URLSearchParams();
  if (params?.status) query.set('status', params.status);
  if (params?.search) query.set('search', params.search);
  if (params?.offset) query.set('offset', String(params.offset));
  const qs = query.toString();
  return apiFetchServer<ConsolePlatformInvitesPage>(`/console/platform-invites${qs ? `?${qs}` : ''}`);
}
