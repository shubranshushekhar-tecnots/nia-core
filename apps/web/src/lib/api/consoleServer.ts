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
 * order steps 6-7; extended for subscription-model Phase 1). `workflowLimit`/
 * `projectLimit` are the *effective* limit (plan default, or the override
 * value when its `*OverrideSet` flag is true) — `null` means genuinely
 * unlimited. The raw `*Override`/`*OverrideSet` fields are exposed
 * separately so the edit form can show/clear the override itself, distinct
 * from the effective number used for display and for the lower-limit
 * warning. `planTier` is the plan's display name (plans.name); `planId`
 * is the catalog id the edit form's dropdown is bound to. `status`/
 * `runs30d` mirror ConsoleOrg's fields above (same hardcoded-'Active'/
 * real-count semantics) so the detail screen's header meta line can reuse
 * the Directory screen's exact "{plan} · {N} people · {M} runs in 30 days
 * · {status}" format. `rowsLimit`/`copilotLimit`/`rowsUsed`/`copilotUsed`
 * (Subscription Phase 3, Slice 5) are display-only, current-calendar-month
 * usage against `plans.rows_per_month`/`plans.copilot_actions_per_month` —
 * `null` limit means unmetered, same semantics as everywhere else in this
 * file. No override fields for these two (unlike workflow/project limit):
 * org_plan has no override columns for rows/Copilot, so there's nothing to
 * edit yet.
 */
export type ConsoleOrgDetail = {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  planId: string;
  planTier: string;
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
  runs30d: number;
  members: ConsoleOrgMember[];
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
 * order step 12). `orgCount` mirrors `ConsoleOrg.memberCount`'s role: useful
 * list context, not a detail field. Same `total`/`limit`/`offset`/`hasMore`
 * paging shape as `ConsoleOrgsPage` (decision 10's "never silently
 * truncate" rule applies identically here).
 */
export type ConsoleUser = {
  id: string;
  name: string;
  email: string;
  orgCount: number;
  createdAt: string;
};

export type ConsoleUsersPage = {
  users: ConsoleUser[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export async function getConsoleUsers(params?: { search?: string; offset?: number }): Promise<ConsoleUsersPage> {
  const query = new URLSearchParams();
  if (params?.search) query.set('search', params.search);
  if (params?.offset) query.set('offset', String(params.offset));
  const qs = query.toString();
  return apiFetchServer<ConsoleUsersPage>(`/console/users${qs ? `?${qs}` : ''}`);
}

/**
 * GET /console/users/:userId's response shape (Slice 3e). Profile, org
 * memberships (with role), and session count/last-sign-in metadata only —
 * never a password, token, or 2FA-secret field, per routes/console.ts's own
 * doc comment on this route's explicit SELECT/response allowlist.
 */
export type ConsoleUserMembership = {
  orgId: string;
  orgName: string;
  role: string;
  joinedAt: string;
};

export type ConsoleUserDetail = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: string;
  memberships: ConsoleUserMembership[];
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
