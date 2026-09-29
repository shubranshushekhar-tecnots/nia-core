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
  workflowLimit: number | null;
  workflowsUsed: number;
  runs30d: number;
  members: ConsoleOrgMember[];
};

export async function getConsoleOrg(orgId: string): Promise<ConsoleOrgDetail> {
  return apiFetchServer<ConsoleOrgDetail>(`/console/orgs/${encodeURIComponent(orgId)}`);
}
