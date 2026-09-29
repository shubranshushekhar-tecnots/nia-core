import { getSessionUser } from '@/lib/auth/session';
import { getConsoleOrgs } from '@/lib/api/consoleServer';
import ConsoleShell from '@/components/console/ConsoleShell';
import ConsoleDirectoryClient from '@/components/console/ConsoleDirectoryClient';

// Slice 1 (docs/plans/console-plan.md §5a): the Directory screen is the
// only built Console screen, so it's the root /console page. layout.tsx has
// already confirmed the caller is staff before this ever renders.
export default async function ConsolePage() {
  const [user, page] = await Promise.all([getSessionUser(), getConsoleOrgs()]);

  return (
    <ConsoleShell activeNavId="directory" email={user?.email ?? ''}>
      <ConsoleDirectoryClient initialPage={page} />
    </ConsoleShell>
  );
}
