import { getSessionUser } from '@/lib/auth/session';
import { getConsoleStaff } from '@/lib/api/consoleServer';
import ConsoleShell from '@/components/console/ConsoleShell';
import ConsoleStaffClient from '@/components/console/ConsoleStaffClient';

// Console redesign plan's Slice 5: reached via ConsoleShell's 'staff' nav
// entry. Fetches the first page server-side; "Load more" paginates via a
// Server Action, same split as the Users and Organizations list screens.
export default async function ConsoleStaffPage() {
  const [user, page] = await Promise.all([getSessionUser(), getConsoleStaff()]);

  return (
    <ConsoleShell activeNavId="staff" email={user?.email ?? ''}>
      <ConsoleStaffClient initialPage={page} />
    </ConsoleShell>
  );
}
