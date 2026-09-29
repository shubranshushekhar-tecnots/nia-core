import { requireUser } from '@/lib/auth/session';
import { getSidebarProjects } from '@/lib/api/dashboardServer';
import { getConnectorCatalog, getConnectorInstalls, getConnections, getConnectionGrants } from '@/lib/api/connectionsServer';
import type { WriteGrant } from '@/lib/api/connectionsClient';
import AppShell from '@/components/app/AppShell';
import Sidebar from '@/components/app/Sidebar';
import TopBar from '@/components/app/TopBar';
import ConnectionsClient from '@/components/app/ConnectionsClient';
import { homeScrollStyle, mainColStyle } from '@/components/app/styles';

export default async function ConnectionsPage() {
  const user = await requireUser();
  const orgId = user.org?.id ?? null;
  const [projects, catalog, installs, connections] = await Promise.all([
    getSidebarProjects(),
    getConnectorCatalog(),
    getConnectorInstalls(),
    getConnections(),
  ]);

  // Learning mode, Step 7 — one grants fetch per connection, each with its
  // own try/catch (not a single Promise.all) so one connection's failed
  // grants fetch never fails the whole page load. `null` is the only
  // "couldn't load" signal ConnectionsClient gets for a connection, kept
  // strictly distinct from a real empty array (0 grants) — never
  // collapsed to "none".
  const grantsEntries = await Promise.all(
    connections.map(async (c): Promise<[string, WriteGrant[] | null]> => {
      try {
        return [c.id, await getConnectionGrants(c.id)];
      } catch {
        return [c.id, null];
      }
    }),
  );
  const grantsByConnection: Record<string, WriteGrant[] | null> = Object.fromEntries(grantsEntries);

  return (
    <AppShell topBar={<TopBar orgName={user.org?.name ?? null} email={user.email} userId={user.userId} />}>
      <Sidebar orgId={orgId} role={user.role} projects={projects} email={user.email} />
      <div style={mainColStyle}>
        <div style={homeScrollStyle}>
          <ConnectionsClient
            currentUserId={user.userId}
            catalog={catalog}
            installs={installs}
            connections={connections}
            grantsByConnection={grantsByConnection}
          />
        </div>
      </div>
    </AppShell>
  );
}
