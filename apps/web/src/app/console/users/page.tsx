import type { Metadata } from 'next';
import { getSessionUser } from '@/lib/auth/session';
import { getConsolePlans, getConsoleUsers } from '@/lib/api/consoleServer';
import ConsoleShell from '@/components/console/ConsoleShell';
import ConsoleUsersClient from '@/components/console/ConsoleUsersClient';

export const metadata: Metadata = { title: 'Console · Users' };

// Slice 3e (docs/plans/console-plan.md build order step 12), extended for
// the plan-visibility work's role/plan/workspaceType filters. Same eager
// first-page-server-side pattern as app/console/page.tsx (Directory) —
// ConsoleUsersClient's search box re-fetches subsequent pages itself via
// searchUsersAction. `plans` is fetched here (not inside the client
// component) purely to resolve each row's `effectivePlanId` to a display
// name and to populate the plan filter's options, same reason
// ConsoleOrgDetailClient takes `plans` as a prop rather than fetching it.
export default async function ConsoleUsersPage() {
  const [user, page, { plans }] = await Promise.all([getSessionUser(), getConsoleUsers(), getConsolePlans()]);

  return (
    <ConsoleShell activeNavId="users" email={user?.email ?? ''}>
      <ConsoleUsersClient initialPage={page} plans={plans} />
    </ConsoleShell>
  );
}
