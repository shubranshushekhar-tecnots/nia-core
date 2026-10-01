import { getSessionUser } from '@/lib/auth/session';
import { getConsoleDashboardData } from '@/lib/api/consoleServer';
import ConsoleShell from '@/components/console/ConsoleShell';
import ConsoleDashboardClient from '@/components/console/ConsoleDashboardClient';

// Console v2 Slice 6: reached via ConsoleShell's 'dash' ("Platform") nav
// entry. Unlike the usage page, this is a fixed, unfiltered platform-wide
// view with no Server Action reload — just one server-side fetch.
export default async function ConsoleDashboardPage() {
  const [user, data] = await Promise.all([getSessionUser(), getConsoleDashboardData()]);

  return (
    <ConsoleShell activeNavId="dash" email={user?.email ?? ''}>
      <ConsoleDashboardClient data={data} />
    </ConsoleShell>
  );
}
