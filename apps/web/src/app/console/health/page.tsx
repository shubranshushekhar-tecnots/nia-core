import type { Metadata } from 'next';
import { getSessionUser } from '@/lib/auth/session';
import { getConsoleHealth } from '@/lib/api/consoleServer';
import ConsoleShell from '@/components/console/ConsoleShell';
import ConsoleHealthClient from '@/components/console/ConsoleHealthClient';

export const metadata: Metadata = { title: 'Console · Health' };

// Console redesign plan's Slice 4: reached via ConsoleShell's 'health' nav
// entry. Fixed, unfiltered platform-wide snapshot — no filters/reload, same
// shape as the dashboard overview page.
export default async function ConsoleHealthPage() {
  const [user, data] = await Promise.all([getSessionUser(), getConsoleHealth()]);

  return (
    <ConsoleShell activeNavId="health" email={user?.email ?? ''}>
      <ConsoleHealthClient data={data} />
    </ConsoleShell>
  );
}
