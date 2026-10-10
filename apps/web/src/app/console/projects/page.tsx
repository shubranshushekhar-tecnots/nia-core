import type { Metadata } from 'next';
import { getSessionUser } from '@/lib/auth/session';
import { getConsoleProjects } from '@/lib/api/consoleServer';
import ConsoleShell from '@/components/console/ConsoleShell';
import ConsoleProjectsClient from '@/components/console/ConsoleProjectsClient';

export const metadata: Metadata = { title: 'Console · Projects' };

export default async function ConsoleProjectsPage() {
  const [user, page] = await Promise.all([getSessionUser(), getConsoleProjects()]);

  return (
    <ConsoleShell activeNavId="projects" email={user?.email ?? ''}>
      <ConsoleProjectsClient initialPage={page} />
    </ConsoleShell>
  );
}
