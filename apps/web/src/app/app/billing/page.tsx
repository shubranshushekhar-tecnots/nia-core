import { requireUser } from '@/lib/auth/session';
import { getDashboardStats, getSidebarProjects } from '@/lib/api/dashboardServer';
import { getPlanUsage } from '@/lib/billing/plan';
import AppShell from '@/components/app/AppShell';
import Sidebar from '@/components/app/Sidebar';
import TopBar from '@/components/app/TopBar';
import { homeScrollStyle, mainColStyle, pageEmptyCardStyle, pageTitleStyle, soonBtnStyle } from '@/components/app/styles';

export default async function BillingPage() {
  const user = await requireUser();
  const orgId = user.org?.id ?? null;
  const [projects, stats] = await Promise.all([getSidebarProjects(), getDashboardStats()]);
  const plan = getPlanUsage(stats.workflowCount);

  return (
    <AppShell topBar={<TopBar orgName={user.org?.name ?? null} email={user.email} />}>
      <Sidebar orgId={orgId} role={user.role} projects={projects} email={user.email} />
      <div style={mainColStyle}>
        <div style={homeScrollStyle}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={pageTitleStyle}>Billing</span>
            <span style={{ fontSize: 13.5, color: 'var(--text-3)' }}>
              Your plan, usage and payment details.
            </span>
          </div>

          <div style={pageEmptyCardStyle}>
            <span style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--text)' }}>
              {plan.plan} plan {'\u00b7'} {plan.used} of {plan.limit} workflows used
            </span>
            <span>
              An Organization plan adds seats, roles and unlimited workflows. Plan management and invoicing are
              coming soon.
            </span>
            <button type="button" style={soonBtnStyle} disabled title="Coming soon">
              Upgrade plan {'\u2014'} coming soon
            </button>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
