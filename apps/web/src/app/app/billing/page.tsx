import { requireUser } from '@/lib/auth/session';
import { getDashboardStats, getSidebarProjects } from '@/lib/api/dashboardServer';
import { getPlanUsage } from '@/lib/billing/plan';
import AppShell from '@/components/app/AppShell';
import Sidebar from '@/components/app/Sidebar';
import TopBar from '@/components/app/TopBar';
import { homeScrollStyle, mainColStyle, pageTitleStyle, soonBtnStyle } from '@/components/app/styles';
import {
  billingUsageCardStyle,
  billingUsageGridStyle,
  billingUsageLabelStyle,
  billingUsageMeterFillStyle,
  billingUsageMeterTrackStyle,
  billingUsageValueStyle,
} from '@/components/billing/styles';

function usagePct(used: number, limit: number | null): number {
  return limit === null ? 0 : Math.min(100, Math.round((100 * used) / limit));
}

function UsageCard({ label, used, limit, unit }: { label: string; used: number; limit: number | null; unit: string }) {
  const pct = usagePct(used, limit);
  return (
    <div style={billingUsageCardStyle}>
      <span style={billingUsageLabelStyle}>{label}</span>
      <span style={billingUsageValueStyle}>
        {used} <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-3)' }}>/ {limit === null ? `Unlimited ${unit}` : `${limit} ${unit}`}</span>
      </span>
      <div
        role="meter"
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={limit ?? undefined}
        aria-label={label}
        style={billingUsageMeterTrackStyle}
      >
        <div style={{ ...billingUsageMeterFillStyle, width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default async function BillingPage() {
  const user = await requireUser();
  const orgId = user.org?.id ?? null;
  const [projects, stats] = await Promise.all([getSidebarProjects(), getDashboardStats()]);
  const plan = getPlanUsage(stats.workflowCount, stats.projectCount, stats.planTier, stats.workflowLimit, stats.projectLimit);

  return (
    <AppShell topBar={<TopBar orgName={user.org?.name ?? null} email={user.email} userId={user.userId} />}>
      <Sidebar orgId={orgId} role={user.role} projects={projects} email={user.email} />
      <div style={mainColStyle}>
        <div style={homeScrollStyle}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={pageTitleStyle}>Billing</span>
            <span style={{ fontSize: 13.5, color: 'var(--text-3)' }}>
              {plan.plan} plan {'\u00b7'} usage and payment details.
            </span>
          </div>

          <div style={billingUsageGridStyle}>
            <UsageCard label="Workflows used" used={plan.workflowUsed} limit={plan.workflowLimit} unit="workflows" />
            <UsageCard label="Projects used" used={plan.projectUsed} limit={plan.projectLimit} unit="projects" />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 460 }}>
            <span style={{ fontSize: 13.5, color: 'var(--text-3)' }}>
              An Organization plan adds seats, roles and higher limits. Plan management and invoicing are coming
              soon.
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
