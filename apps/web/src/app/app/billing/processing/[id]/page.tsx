import { requireUser } from '@/lib/auth/session';
import { getSidebarProjects } from '@/lib/api/dashboardServer';
import AppShell from '@/components/app/AppShell';
import Sidebar from '@/components/app/Sidebar';
import TopBar from '@/components/app/TopBar';
import ProcessingStatus from '@/components/billing/ProcessingStatus';
import { homeScrollStyle, mainColStyle } from '@/components/app/styles';
import {
  nxBillingPageTagStyle,
  nxBillingProcessingLeftColStyle,
  nxBillingProcessingRowStyle,
  nxBillingProcessingTitleStyle,
  nxBillingTitleColStyle,
} from '@/components/billing/styles';

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
          fullName={user.fullName}
          orgs={user.orgs}
          activeOrgId={user.org?.id ?? null}
          crumbs={[{ label: 'Billing', href: '/app/billing' }, { label: 'Processing' }]}
        />
      }
    >
      <Sidebar orgId={orgId} role={user.role} projects={projects} />
      <div style={mainColStyle}>
        <div style={homeScrollStyle}>
          <div style={nxBillingProcessingRowStyle}>
            <div style={nxBillingProcessingLeftColStyle}>
              <div style={nxBillingTitleColStyle}>
                <span style={nxBillingPageTagStyle}>Upgrade {'\u00b7'} Subscription {id}</span>
                <h1 style={nxBillingProcessingTitleStyle}>Upgrade</h1>
              </div>
            </div>
            <ProcessingStatus subscriptionId={id} checkoutUrl={checkoutUrl ?? null} />
          </div>
        </div>
      </div>
    </AppShell>
  );
}
