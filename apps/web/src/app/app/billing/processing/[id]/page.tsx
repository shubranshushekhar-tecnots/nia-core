import { requireUser } from '@/lib/auth/session';
import { getSidebarProjects } from '@/lib/api/dashboardServer';
import AppShell from '@/components/app/AppShell';
import Sidebar from '@/components/app/Sidebar';
import TopBar from '@/components/app/TopBar';
import ProcessingStatus from '@/components/billing/ProcessingStatus';
import { homeScrollStyle, mainColStyle, pageTitleStyle } from '@/components/app/styles';

export default async function BillingProcessingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ checkoutUrl?: string }>;
}) {
  const { id } = await params;
  const { checkoutUrl } = await searchParams;
  const user = await requireUser();
  const orgId = user.org?.id ?? null;
  const projects = await getSidebarProjects();

  return (
    <AppShell
      topBar={
        <TopBar
          orgName={user.org?.name ?? null}
          email={user.email}
          userId={user.userId}
          orgs={user.orgs}
          activeOrgId={user.org?.id ?? null}
          crumbs={[{ label: 'Billing', href: '/app/billing' }, { label: 'Processing' }]}
        />
      }
    >
      <Sidebar orgId={orgId} role={user.role} projects={projects} email={user.email} />
      <div style={mainColStyle}>
        <div style={homeScrollStyle}>
          <span style={pageTitleStyle}>Upgrade</span>
          <ProcessingStatus subscriptionId={id} checkoutUrl={checkoutUrl ?? null} />
        </div>
      </div>
    </AppShell>
  );
}
