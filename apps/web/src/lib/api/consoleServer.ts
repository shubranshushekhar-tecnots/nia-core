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
 * order steps 6-7). `workflowLimit` is `null` for genuinely unlimited plans
 * (org_plan's own semantics — see routes/console.ts's doc comment); it is
 * never `null` because of a missing row, the API always resolves that to
 * today's Pro/25 default server-side. `status`/`runs30d` mirror ConsoleOrg's
 * fields above (same hardcoded-'Active'/real-count semantics) so the detail
 * screen's header meta line can reuse the Directory screen's exact
 * "{plan} · {N} people · {M} runs in 30 days · {status}" format.
 */
export type ConsoleOrgDetail = {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  planTier: string;
  status: string;
  suspendedAt: string | null;
  suspendedReason: string | null;
  suspendedBy: { userId: string; name: string | null } | null;
  workflowLimit: number | null;
  workflowsUsed: number;
  runs30d: number;
  members: ConsoleOrgMember[];
};

export async function getConsoleOrg(orgId: string): Promise<ConsoleOrgDetail> {
  return apiFetchServer<ConsoleOrgDetail>(`/console/orgs/${encodeURIComponent(orgId)}`);
}

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
