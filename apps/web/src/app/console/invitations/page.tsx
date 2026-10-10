import type { Metadata } from 'next';
import { getSessionUser } from '@/lib/auth/session';
import { getConsolePlans, getConsolePlatformInvites } from '@/lib/api/consoleServer';
import ConsoleShell from '@/components/console/ConsoleShell';
import ConsoleInvitationsClient from '@/components/console/ConsoleInvitationsClient';

export const metadata: Metadata = { title: 'Console · Invitations' };

// Email Phase 3: staff-initiated direct platform invites. Same eager
// first-page-server-side pattern as app/console/access-requests/page.tsx
// — ConsoleInvitationsClient's status-tab switch and search box re-fetch
// subsequent pages themselves via loadPlatformInvitesAction.
export default async function ConsoleInvitationsPage() {
  const [user, page, { plans }] = await Promise.all([
    getSessionUser(),
    getConsolePlatformInvites({ status: 'pending' }),
    getConsolePlans(),
  ]);

  return (
    <ConsoleShell activeNavId="invitations" email={user?.email ?? ''}>
      <ConsoleInvitationsClient initialPage={page} plans={plans} />
    </ConsoleShell>
  );
}
