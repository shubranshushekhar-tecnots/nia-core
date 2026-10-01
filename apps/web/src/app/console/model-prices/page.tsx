import { getSessionUser } from '@/lib/auth/session';
import { getConsoleModelPrices } from '@/lib/api/consoleServer';
import ConsoleShell from '@/components/console/ConsoleShell';
import ConsoleModelPricesClient from '@/components/console/ConsoleModelPricesClient';

export default async function ConsoleModelPricesPage() {
  const [user, page] = await Promise.all([getSessionUser(), getConsoleModelPrices()]);

  return (
    <ConsoleShell activeNavId="model-prices" email={user?.email ?? ''}>
      <ConsoleModelPricesClient initialPage={page} />
    </ConsoleShell>
  );
}
