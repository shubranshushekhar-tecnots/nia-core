import type { Metadata } from 'next';
import { getSessionUser } from '@/lib/auth/session';
import { getConsoleAccessRequests, getConsolePlans } from '@/lib/api/consoleServer';
import ConsoleShell from '@/components/console/ConsoleShell';
import ConsoleAccessRequestsClient from '@/components/console/ConsoleAccessRequestsClient';

export const metadata: Metadata = { title: 'Console · Access Requests' };

// Email Phase 3: staff review queue for the public /request-access form.
// Same eager first-page-server-side pattern as app/console/users/page.tsx
// — ConsoleAccessRequestsClient's status-tab switch and search box re-fetch
// subsequent pages themselves via loadAccessRequestsAction.
export default async function ConsoleAccessRequestsPage() {
  const [user, page, { plans }] = await Promise.all([
    getSessionUser(),
    getConsoleAccessRequests({ status: 'pending' }),
    getConsolePlans(),
  ]);

  return (
    <ConsoleShell activeNavId="access-requests" email={user?.email ?? ''}>
      <ConsoleAccessRequestsClient initialPage={page} plans={plans} />
    </ConsoleShell>
  );
}
