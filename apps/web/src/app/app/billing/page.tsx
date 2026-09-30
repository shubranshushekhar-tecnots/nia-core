import { requireUser } from '@/lib/auth/session';
import { getDashboardStats, getSidebarProjects } from '@/lib/api/dashboardServer';
import { getPlanUsage } from '@/lib/billing/plan';
import AppShell from '@/components/app/AppShell';
import Sidebar from '@/components/app/Sidebar';
import TopBar from '@/components/app/TopBar';
import UpgradeSection from '@/components/billing/UpgradeSection';
import { homeScrollStyle, mainColStyle, pageTitleStyle, soonBtnStyle } from '@/components/app/styles';
import {
  billingBlockedBannerStyle,
  billingUsageCardStyle,
  billingUsageGridStyle,
  billingUsageLabelStyle,
  billingUsageMeterFillStyle,
  billingUsageMeterTrackStyle,
  billingUsageValueStyle,
  billingWarningBannerStyle,
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

// Subscription Phase 3, Slice 4 — 80% warns, 100% reads as blocked (matches
// decision 5's enforcement copy for Free rows / any metered plan's Copilot
// actions; a Pro/Team row banner at 100% is still shown here even though
// runs aren't actually blocked for them, since it's still worth surfacing).
function UsageBanner({ label, used, limit, planName }: { label: string; used: number; limit: number | null; planName: string }) {
  if (limit === null) return null;
  const pct = usagePct(used, limit);
  if (pct < 80) return null;

  if (pct >= 100) {
    return (
      <div style={billingBlockedBannerStyle}>
        <strong>{label} limit reached</strong>
        <span>
          Your {planName} plan includes {limit.toLocaleString()} {label.toLowerCase()} a month, and you've already used{' '}
          {used.toLocaleString()}. Upgrade to keep going this month.
        </span>
      </div>
    );
  }

  return (
    <div style={billingWarningBannerStyle}>
      <strong>Approaching your {label.toLowerCase()} limit</strong>
      <span>
        {used.toLocaleString()} of {limit.toLocaleString()} {label.toLowerCase()} used this month on the {planName} plan.
      </span>
    </div>
  );
}

export default async function BillingPage() {
  const user = await requireUser();
  const orgId = user.org?.id ?? null;
  const [projects, stats] = await Promise.all([getSidebarProjects(), getDashboardStats()]);
  const plan = getPlanUsage(stats);

  return (
    <AppShell
      topBar={
        <TopBar
          orgName={user.org?.name ?? null}
          email={user.email}
          userId={user.userId}
          orgs={user.orgs}
          activeOrgId={user.org?.id ?? null}
        />
      }
    >
      <Sidebar orgId={orgId} role={user.role} projects={projects} email={user.email} />
      <div style={mainColStyle}>
        <div style={homeScrollStyle}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={pageTitleStyle}>Billing</span>
            <span style={{ fontSize: 13.5, color: 'var(--text-3)' }}>
              {plan.plan} plan {'\u00b7'} usage and payment details {'\u00b7'} {plan.periodDaysLeft}{' '}
              {plan.periodDaysLeft === 1 ? 'day' : 'days'} left this month.
            </span>
          </div>

          <div style={billingUsageGridStyle}>
            <UsageCard label="Workflows used" used={plan.workflowUsed} limit={plan.workflowLimit} unit="workflows" />
            <UsageCard label="Projects used" used={plan.projectUsed} limit={plan.projectLimit} unit="projects" />
            <UsageCard label="Rows moved" used={plan.rowsUsed} limit={plan.rowsLimit} unit="rows" />
            <UsageCard label="Copilot actions" used={plan.copilotUsed} limit={plan.copilotLimit} unit="actions" />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 460 }}>
            <UsageBanner label="Rows" used={plan.rowsUsed} limit={plan.rowsLimit} planName={plan.plan} />
            <UsageBanner label="Copilot actions" used={plan.copilotUsed} limit={plan.copilotLimit} planName={plan.plan} />
          </div>

          {orgId ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 460 }}>
              <span style={{ fontSize: 13.5, color: 'var(--text-3)' }}>
                An Organization plan adds seats, roles and higher limits. Plan management and invoicing are coming
                soon.
              </span>
              <button type="button" style={soonBtnStyle} disabled title="Coming soon">
                Upgrade plan {'\u2014'} coming soon
              </button>
            </div>
          ) : (
            <UpgradeSection />
          )}
        </div>
      </div>
    </AppShell>
  );
}
