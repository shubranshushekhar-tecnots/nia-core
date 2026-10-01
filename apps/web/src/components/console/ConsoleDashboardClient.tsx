import Link from 'next/link';
import type { ConsoleDashboardData, ConsoleNeedsAttentionItem } from '@/lib/api/consoleServer';
import ConsoleDashboardCharts from './ConsoleDashboardCharts';
import ConsoleUsageCharts, { formatUsd } from './ConsoleUsageCharts';
import StatusPill, { type StatusTone } from './StatusPill';
import {
  consoleContentStyle,
  consoleEmptyStyle,
  consoleHeaderRowStyle,
  consoleHeaderSubStyle,
  consoleHeaderTitleColStyle,
  consoleHeaderTitleStyle,
  consoleRowLinkStyle,
  consoleSectionTitleStyle,
  consoleStatCardStyle,
  consoleStatLabelStyle,
  consoleStatValueStyle,
  consoleStatsRowStyle,
} from './styles';
import {
  consoleDashboardAttentionDetailStyle,
  consoleDashboardAttentionListStyle,
  consoleDashboardAttentionOrgColStyle,
  consoleDashboardAttentionOrgNameStyle,
  consoleDashboardAttentionRowStyle,
  consoleDashboardSectionStyle,
} from './dashboardStyles';

/**
 * Console v2 Slice 6 — platform dashboard home. Server component (no
 * filters/reload here, unlike the usage page — this is a fixed, unfiltered
 * platform-wide overview), reached via ConsoleShell's 'dash' nav entry
 * ("Platform"). Composes: an overview stat row (orgs/users/active users/
 * rows moved), the runs-per-day + rows-per-day charts (ConsoleDashboardCharts),
 * a tokens+cost section reusing Slice 5's ConsoleUsageCharts/formatUsd
 * directly (no duplicate chart code), and a needs-attention list (suspended
 * orgs, orgs near their workflow limit, orgs with recent failing runs) each
 * row linking to that org's Org Detail page.
 */

function attentionTone(reason: ConsoleNeedsAttentionItem['reason']): StatusTone {
  return reason === 'suspended' ? 'error' : reason === 'failing_runs' ? 'error' : 'warning';
}

function attentionLabel(reason: ConsoleNeedsAttentionItem['reason']): string {
  if (reason === 'suspended') return 'Suspended';
  if (reason === 'near_limit') return 'Near limit';
  return 'Failing runs';
}

function NeedsAttentionList({ items }: { items: ConsoleNeedsAttentionItem[] }) {
  return (
    <div style={consoleDashboardSectionStyle}>
      <h3 style={consoleSectionTitleStyle}>Needs attention</h3>
      {items.length === 0 ? (
        <div style={consoleEmptyStyle}>Nothing needs attention right now.</div>
      ) : (
        <div style={consoleDashboardAttentionListStyle}>
          {items.map((item, i) => (
            <Link key={`${item.orgId}-${item.reason}-${i}`} href={`/console/orgs/${item.orgId}`} style={consoleRowLinkStyle}>
              <div style={consoleDashboardAttentionRowStyle}>
                <div style={consoleDashboardAttentionOrgColStyle}>
                  <span style={consoleDashboardAttentionOrgNameStyle}>{item.orgName}</span>
                  <span style={consoleDashboardAttentionDetailStyle}>{item.detail}</span>
                </div>
                <StatusPill tone={attentionTone(item.reason)} label={attentionLabel(item.reason)} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ConsoleDashboardClient({ data }: { data: ConsoleDashboardData }) {
  const { overview, runsPerDay, rowsMoved, needsAttention, usageSummary, usageTimeseries } = data;

  return (
    <div style={consoleContentStyle}>
      <div style={consoleHeaderRowStyle}>
        <div style={consoleHeaderTitleColStyle}>
          <h1 style={consoleHeaderTitleStyle}>Platform</h1>
          <span style={consoleHeaderSubStyle}>Orgs, usage, and health across the whole platform.</span>
        </div>
      </div>

      <div style={consoleStatsRowStyle}>
        <div style={consoleStatCardStyle}>
          <span style={consoleStatLabelStyle}>Orgs</span>
          <span style={consoleStatValueStyle}>{overview.totalOrgs.toLocaleString()}</span>
        </div>
        <div style={consoleStatCardStyle}>
          <span style={consoleStatLabelStyle}>Users</span>
          <span style={consoleStatValueStyle}>{overview.totalUsers.toLocaleString()}</span>
        </div>
        <div style={consoleStatCardStyle}>
          <span style={consoleStatLabelStyle}>Active users (30d)</span>
          <span style={consoleStatValueStyle}>{overview.activeUsers30d.toLocaleString()}</span>
        </div>
        <div style={consoleStatCardStyle}>
          <span style={consoleStatLabelStyle}>Rows moved (30d)</span>
          <span style={consoleStatValueStyle}>{rowsMoved.last30d.toLocaleString()}</span>
        </div>
        <div style={consoleStatCardStyle}>
          <span style={consoleStatLabelStyle}>Rows moved (all time)</span>
          <span style={consoleStatValueStyle}>{rowsMoved.allTime.toLocaleString()}</span>
        </div>
      </div>

      <ConsoleDashboardCharts runsPerDay={runsPerDay} />

      <div style={consoleDashboardSectionStyle}>
        <h3 style={consoleSectionTitleStyle}>Tokens + cost</h3>
        <div style={consoleStatsRowStyle}>
          <div style={consoleStatCardStyle}>
            <span style={consoleStatLabelStyle}>Today — tokens</span>
            <span style={consoleStatValueStyle}>{usageSummary.today.totalTokens.toLocaleString()}</span>
          </div>
          <div style={consoleStatCardStyle}>
            <span style={consoleStatLabelStyle}>Today — cost</span>
            <span style={consoleStatValueStyle}>{formatUsd(usageSummary.today.cost)}</span>
          </div>
          <div style={consoleStatCardStyle}>
            <span style={consoleStatLabelStyle}>This month — tokens</span>
            <span style={consoleStatValueStyle}>{usageSummary.month.totalTokens.toLocaleString()}</span>
          </div>
          <div style={consoleStatCardStyle}>
            <span style={consoleStatLabelStyle}>This month — cost</span>
            <span style={consoleStatValueStyle}>{formatUsd(usageSummary.month.cost)}</span>
          </div>
        </div>
        <ConsoleUsageCharts timeseries={usageTimeseries} />
      </div>

      <NeedsAttentionList items={needsAttention} />
    </div>
  );
}
