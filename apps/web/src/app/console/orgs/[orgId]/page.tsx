import { notFound } from 'next/navigation';
import { getSessionUser } from '@/lib/auth/session';
import {
  getConsoleOrg,
  getConsoleOrgConnectors,
  getConsoleOrgRuns,
  getConsolePlans,
  type ConsoleConnector,
  type ConsolePlan,
  type ConsoleRun,
} from '@/lib/api/consoleServer';
import { ApiError } from '@/lib/api/server';
import ConsoleShell from '@/components/console/ConsoleShell';
import ConsoleOrgDetailClient from '@/components/console/ConsoleOrgDetailClient';

// Slice 2 (docs/plans/console-plan.md §5a, build order steps 6-7): Org
// Detail, reached only via a link from the Directory screen — there is no
// dedicated sidebar nav entry for it (ConsoleShell's NAV list is unchanged),
// same as the design itself, which reaches this screen from the Directory
// table's row click, not from the sidebar.
//
// A 404 from GET /console/orgs/:orgId (org not found — e.g. a stale link,
// or an org deleted after step 9 lands) renders Next's real notFound(),
// same as layout.tsx already does for the staff-gate itself; a 5xx or
// transport failure is logged then also rendered as notFound() rather than
// a 500 page, matching layout.tsx's existing "never leak the console's
// internals" posture. Only a genuine 404 is expected in normal use — a
// staff session already passed layout.tsx's own ping check to get here.
export default async function ConsoleOrgDetailPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;

  const [user, org, plans, runs, connectors] = await Promise.all([
    getSessionUser(),
    getConsoleOrg(orgId).catch((err) => {
      if (err instanceof ApiError) {
        if (err.status >= 500) {
          console.error('[console] GET /console/orgs/:orgId failed with a 5xx', err);
        }
        notFound();
      }
      console.error('[console] GET /console/orgs/:orgId failed (network/transport error)', err);
      notFound();
    }),
    // Subscription model Phase 1: the plan catalog for the edit-plan
    // form's dropdown. Degrades to `[]` on failure rather than notFound()
    // — this screen's own existence doesn't depend on it, only the Edit
    // plan form does, and an empty dropdown is a clear enough signal.
    getConsolePlans()
      .then((page) => page.plans)
      .catch((err): ConsolePlan[] => {
        console.error('[console] GET /console/plans failed', err);
        return [];
      }),
    // Slice 3c: the Runs tab is secondary to the org detail itself, so a
    // failure here degrades gracefully rather than notFound() — unlike
    // getConsoleOrg above, which is the page's own existence check. Small
    // fix (2026-09-29): degrade to `null` (fetch failed), not `[]` (org
    // genuinely has zero runs) — ConsoleOrgDetailClient renders these two
    // cases with different copy so a transport error never looks like a
    // quiet "no runs yet".
    getConsoleOrgRuns(orgId)
      .then((page) => page.runs)
      .catch((err): ConsoleRun[] | null => {
        console.error('[console] GET /console/orgs/:orgId/runs failed', err);
        return null;
      }),
    // Slice 3d: same degrade-to-null-on-failure pattern as runs above — a
    // transport/5xx failure must never render as "this org has zero
    // connectors" (see ConsoleOrgDetailClient's Connectors tab).
    getConsoleOrgConnectors(orgId)
      .then((page) => page.connectors)
      .catch((err): ConsoleConnector[] | null => {
        console.error('[console] GET /console/orgs/:orgId/connectors failed', err);
        return null;
      }),
  ]);

  return (
    <ConsoleShell activeNavId="directory" email={user?.email ?? ''}>
      <ConsoleOrgDetailClient org={org} plans={plans} runs={runs} connectors={connectors} />
    </ConsoleShell>
  );
}
