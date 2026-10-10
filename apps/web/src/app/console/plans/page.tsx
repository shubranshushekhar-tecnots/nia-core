import type { Metadata } from 'next';
import { getSessionUser } from '@/lib/auth/session';
import { getConsolePlans } from '@/lib/api/consoleServer';
import ConsoleShell from '@/components/console/ConsoleShell';
import ConsolePlansClient from '@/components/console/ConsolePlansClient';

export const metadata: Metadata = { title: 'Console · Plans' };

export default async function ConsolePlansPage() {
  const [user, { plans }] = await Promise.all([getSessionUser(), getConsolePlans()]);

  return (
    <ConsoleShell activeNavId="plans" email={user?.email ?? ''}>
      <ConsolePlansClient initialPlans={plans} />
    </ConsoleShell>
  );
}
