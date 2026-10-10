import type { Metadata } from 'next';
import { getSessionUser } from '@/lib/auth/session';
import { getConsoleUsageData } from '@/lib/api/consoleServer';
import ConsoleShell from '@/components/console/ConsoleShell';
import ConsoleUsageClient from '@/components/console/ConsoleUsageClient';

export const metadata: Metadata = { title: 'Console · Usage' };

// Console v2 Slice 5: reached via ConsoleShell's 'usage' nav entry (see its
// own doc comment). Page.tsx fetches the unfiltered (all orgs, all time)
// initial view server-side, same "load unfiltered first, refine via Server
// Action" split as every other Console screen.
export default async function ConsoleUsagePage() {
  const [user, data] = await Promise.all([getSessionUser(), getConsoleUsageData({})]);

  return (
    <ConsoleShell activeNavId="usage" email={user?.email ?? ''}>
      <ConsoleUsageClient initialData={data} />
    </ConsoleShell>
  );
}
