import { requireUser } from '@/lib/auth/session';
import { getDashboardStats, getSidebarProjects } from '@/lib/api/dashboardServer';
import { getPlanUsage } from '@/lib/billing/plan';
import AppShell from '@/components/app/AppShell';
import Sidebar from '@/components/app/Sidebar';
import TopBar from '@/components/app/TopBar';
import UpgradeSection from '@/components/billing/UpgradeSection';
import { homeScrollStyle, mainColStyle } from '@/components/app/styles';
import {
  nxBillingBannerStrongStyle,
  nxBillingBannerStyle,
  nxBillingBannersColStyle,
  nxBillingComingSoonRowStyle,
  nxBillingComingSoonTextStyle,
  nxBillingHeaderLeftColStyle,
  nxBillingHeaderRightColStyle,
  nxBillingHeaderRowStyle,
  nxBillingLimitTextStyle,
  nxBillingMeterFillStyle,
  nxBillingMeterLabelRowStyle,
  nxBillingMeterLabelStyle,
  nxBillingMeterRowStyle,
  nxBillingMeterTrackStyle,
  nxBillingMeterUnlimitedFillStyle,
  nxBillingMeterValueStyle,
  nxBillingOrgCardBodyStyle,
  nxBillingOrgCardBtnTextStyle,
  nxBillingOrgCardFooterStyle,
  nxBillingOrgCardStyle,
  nxBillingPageSubtitleStyle,
  nxBillingPageTagStyle,
  nxBillingPageTitleStyle,
  nxBillingSoonChipStyle,
  nxBillingTitleColStyle,
  nxBillingUpgradeSectionStyle,
  nxBillingUsageCardCellStyle,
  nxBillingUsageCardsRowStyle,
} from '@/components/billing/styles';

function usagePct(used: number, limit: number | null): number {
  return limit === null ? 0 : Math.min(100, Math.round((100 * used) / limit));
}

function MeterRow({ label, used, limit, last }: { label: string; used: number; limit: number | null; last: boolean }) {
  const pct = usagePct(used, limit);
  const atLimit = limit !== null && pct >= 100;
  return (
    <div style={nxBillingMeterRowStyle(last)}>
      <div style={nxBillingMeterLabelRowStyle}>
        <span style={nxBillingMeterLabelStyle}>{label}</span>
        <span style={nxBillingMeterValueStyle}>
          {used} / {limit === null ? 'Unlimited' : limit}
        </span>
      </div>
      <div role="meter" aria-valuenow={used} aria-valuemin={0} aria-valuemax={limit ?? undefined} aria-label={label} style={nxBillingMeterTrackStyle}>
        <div style={limit === null ? nxBillingMeterUnlimitedFillStyle : nxBillingMeterFillStyle(pct, atLimit)} />
      </div>
      {atLimit && <span style={nxBillingLimitTextStyle}>At your limit</span>}
    </div>
  );
}

function UsageCell({ label, used, limit, last }: { label: string; used: number; limit: number | null; last: boolean }) {
  const pct = usagePct(used, limit);
  const atLimit = limit !== null && pct >= 100;
  return (
    <div style={nxBillingUsageCardCellStyle(last)}>
      <div style={nxBillingMeterLabelRowStyle}>
        <span style={nxBillingMeterLabelStyle}>{label}</span>
        <span style={nxBillingMeterValueStyle}>
          {used} / {limit === null ? 'Unlimited' : limit}
        </span>
      </div>
      <div role="meter" aria-valuenow={used} aria-valuemin={0} aria-valuemax={limit ?? undefined} aria-label={label} style={nxBillingMeterTrackStyle}>
        <div style={limit === null ? nxBillingMeterUnlimitedFillStyle : nxBillingMeterFillStyle(pct, atLimit)} />
      </div>
      {atLimit && <span style={nxBillingLimitTextStyle}>At your limit</span>}
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
      <div style={nxBillingBannerStyle('blocked')}>
        <span style={nxBillingBannerStrongStyle}>{label} limit reached</span>
        <span>
          Your {planName} plan includes {limit.toLocaleString()} {label.toLowerCase()} a month, and you've already used{' '}
          {used.toLocaleString()}. Upgrade to keep going this month.
        </span>
      </div>
    );
  }

  return (
    <div style={nxBillingBannerStyle('warn')}>
      <span style={nxBillingBannerStrongStyle}>Approaching your {label.toLowerCase()} limit</span>
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
          fullName={user.fullName}
          orgs={user.orgs}
          activeOrgId={user.org?.id ?? null}
        />
      }
    >
      <Sidebar orgId={orgId} role={user.role} projects={projects} email={user.email} />
      <div style={mainColStyle}>
        <div style={homeScrollStyle}>
          <div style={nxBillingHeaderRowStyle}>
            <div style={nxBillingHeaderLeftColStyle}>
              <div style={nxBillingTitleColStyle}>
                <span style={nxBillingPageTagStyle}>Account / Billing</span>
                <h1 style={nxBillingPageTitleStyle}>Billing</h1>
              </div>
              <span style={nxBillingPageSubtitleStyle}>
                {plan.plan} plan {'\u00b7'} usage and payment details {'\u00b7'} {plan.periodDaysLeft}{' '}
                {plan.periodDaysLeft === 1 ? 'day' : 'days'} left this month.
              </span>
            </div>
            <div style={nxBillingHeaderRightColStyle}>
              <MeterRow label="Workflows used" used={plan.workflowUsed} limit={plan.workflowLimit} last={false} />
              <MeterRow label="Projects used" used={plan.projectUsed} limit={plan.projectLimit} last={true} />
            </div>
          </div>

          <div style={nxBillingUsageCardsRowStyle}>
            <UsageCell label="Rows moved" used={plan.rowsUsed} limit={plan.rowsLimit} last={false} />
            <UsageCell label="Copilot actions" used={plan.copilotUsed} limit={plan.copilotLimit} last={true} />
          </div>

          {(usagePct(plan.rowsUsed, plan.rowsLimit) >= 80 || usagePct(plan.copilotUsed, plan.copilotLimit) >= 80) && (
            <div style={nxBillingBannersColStyle}>
              <UsageBanner label="Rows" used={plan.rowsUsed} limit={plan.rowsLimit} planName={plan.plan} />
              <UsageBanner label="Copilot actions" used={plan.copilotUsed} limit={plan.copilotLimit} planName={plan.plan} />
            </div>
          )}

          {orgId ? (
            <div style={nxBillingOrgCardStyle}>
              <p style={nxBillingOrgCardBodyStyle}>
                An Organization plan adds seats, roles and higher limits. Plan management and invoicing are coming soon.
              </p>
              <div style={nxBillingOrgCardFooterStyle} aria-disabled="true">
                <span style={nxBillingOrgCardBtnTextStyle}>Upgrade plan {'\u2014'} coming soon</span>
                <span style={nxBillingSoonChipStyle}>Soon</span>
              </div>
            </div>
          ) : stats.paymentsEnabled ? (
            <div style={nxBillingUpgradeSectionStyle}>
              <UpgradeSection />
            </div>
          ) : (
            <div style={nxBillingComingSoonRowStyle} aria-disabled="true">
              <span style={nxBillingComingSoonTextStyle}>Upgrades coming soon</span>
              <span style={nxBillingSoonChipStyle}>Soon</span>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
