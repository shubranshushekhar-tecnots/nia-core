import { getSessionUser } from '@/lib/auth/session';
import { getConsoleUsers } from '@/lib/api/consoleServer';
import ConsoleShell from '@/components/console/ConsoleShell';
import ConsoleUsersClient from '@/components/console/ConsoleUsersClient';

// Slice 3e (docs/plans/console-plan.md build order step 12). Same eager
// first-page-server-side pattern as app/console/page.tsx (Directory) —
// ConsoleUsersClient's search box re-fetches subsequent pages itself via
// searchUsersAction.
export default async function ConsoleUsersPage() {
  const [user, page] = await Promise.all([getSessionUser(), getConsoleUsers()]);

  return (
    <ConsoleShell activeNavId="users" email={user?.email ?? ''}>
      <ConsoleUsersClient initialPage={page} />
    </ConsoleShell>
  );
}
