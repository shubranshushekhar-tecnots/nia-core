import type { Metadata } from 'next';
import { getSessionUser } from '@/lib/auth/session';
import { getConsoleAuditLogs } from '@/lib/api/consoleServer';
import ConsoleShell from '@/components/console/ConsoleShell';
import ConsoleAuditLogsClient from '@/components/console/ConsoleAuditLogsClient';

export const metadata: Metadata = { title: 'Console · Audit logs' };

export default async function ConsoleAuditLogsPage() {
  const [user, page] = await Promise.all([getSessionUser(), getConsoleAuditLogs()]);

  return (
    <ConsoleShell activeNavId="audit-logs" email={user?.email ?? ''}>
      <ConsoleAuditLogsClient initialPage={page} />
    </ConsoleShell>
  );
}
