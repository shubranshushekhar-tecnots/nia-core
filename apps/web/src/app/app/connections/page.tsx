import { requireUser } from '@/lib/auth/session';
import { getSidebarProjects } from '@/lib/api/dashboardServer';
import { getConnectorCatalog, getConnectorInstalls, getConnections } from '@/lib/api/connectionsServer';
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

  return (
    <AppShell topBar={<TopBar orgName={user.org?.name ?? null} email={user.email} />}>
      <Sidebar orgId={orgId} role={user.role} projects={projects} email={user.email} />
      <div style={mainColStyle}>
        <div style={homeScrollStyle}>
          <ConnectionsClient
            currentUserId={user.userId}
            catalog={catalog}
            installs={installs}
            connections={connections}
          />
        </div>
      </div>
    </AppShell>
  );
}
