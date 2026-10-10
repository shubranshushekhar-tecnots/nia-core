import type { Metadata } from 'next';
import { getSessionUser } from '@/lib/auth/session';
import { getConsoleAnnouncements } from '@/lib/api/consoleServer';
import ConsoleShell from '@/components/console/ConsoleShell';
import ConsoleAnnouncementsClient from '@/components/console/ConsoleAnnouncementsClient';

export const metadata: Metadata = { title: 'Console · Announcements' };

// Subscription Phase 5, Slice 3 (docs/plans/subscription-model.md, decision
// 1): reached via ConsoleShell's 'notify' nav entry (see its own doc
// comment on why that id was chosen over adding a new one). Page.tsx only
// fetches the first page of the default 'active' tab server-side, same
// "first page server-side, rest via Server Action" split as every other
// Console list screen (getConsoleOrgs/getConsoleUsers).
export default async function ConsoleAnnouncementsPage() {
  const [user, page] = await Promise.all([getSessionUser(), getConsoleAnnouncements({ status: 'active' })]);

  return (
    <ConsoleShell activeNavId="notify" email={user?.email ?? ''}>
      <ConsoleAnnouncementsClient initialPage={page} />
    </ConsoleShell>
  );
}
