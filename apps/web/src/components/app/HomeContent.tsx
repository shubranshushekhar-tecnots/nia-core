'use client';

import type { DashboardStats, RecentRun } from '@/lib/dashboard/types';
import { PLAN_ALERT_THRESHOLD, type PlanUsage } from '@/lib/billing/plan';
import { aggregateDashboard } from '@/lib/dashboard/aggregate';
import { buildActivityFeed, buildDurationSeries, buildNeedsAttention, buildWorkflowRows } from '@/lib/dashboard/homeViewModel';
import {
  greetingLineStyle,
  greetingStyle,
  homeScrollStyle,
  nxGreetingPanelStyle,
  nxGreetingTagStyle,
  planBannerBodyStyle,
  planBannerBtnStyle,
  planBannerPercentCellStyle,
  planBannerStyle,
} from './styles';
import KpiStrip from './home/KpiStrip';
import RunsPerDayChart from './home/RunsPerDayChart';
import RunsSoFarChart from './home/RunsSoFarChart';
import TrendCharts from './home/TrendCharts';
import WorkflowsTable from './home/WorkflowsTable';
import RightPanel from './home/RightPanel';

// Below this many loaded days of history, a 14-day trend line would mostly
// be gaps — show each individual run instead (see RunsSoFarChart). Matches
// the design's own "trends appear after a few days" copy.
const EARLY_DAYS_THRESHOLD = 3;

export default function HomeContent({
  greeting,
  fullName,
  userId,
  orgName,
  recentRuns,
  plan,
  stats,
}: {
  greeting: string;
  fullName: string | null;
  userId: string;
  orgName: string | null;
  recentRuns: RecentRun[];
  plan: PlanUsage;
  stats: DashboardStats;
}) {
  const firstName = fullName?.trim().split(/\s+/)[0];
  const workspaceLabel = `${orgName ?? 'Personal workspace'} \u00b7 ${plan.plan} plan`;

  const aggregate = aggregateDashboard(recentRuns, 50);
  const workflowRows = buildWorkflowRows(recentRuns);
  const needsAttention = buildNeedsAttention(recentRuns);
  const activity = buildActivityFeed(recentRuns);
  const durationSeries = buildDurationSeries(recentRuns, aggregate.days);
  const isEarly = recentRuns.length > 0 && aggregate.windowDays <= EARLY_DAYS_THRESHOLD;
  const historyDays = Math.min(aggregate.windowDays, EARLY_DAYS_THRESHOLD);

  const workflowPct = plan.workflowLimit !== null ? Math.round((100 * plan.workflowUsed) / plan.workflowLimit) : null;
  const rowsPct = plan.rowsLimit !== null ? Math.round((100 * plan.rowsUsed) / plan.rowsLimit) : null;
  const copilotPct = plan.copilotLimit !== null ? Math.round((100 * plan.copilotUsed) / plan.copilotLimit) : null;

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <div style={homeScrollStyle}>
        <div className="nx-fade-up" style={nxGreetingPanelStyle}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <span className="nx-clip-line" style={nxGreetingTagStyle}>
              Your workspace
            </span>
            <span style={greetingLineStyle}>
              {stats.projectCount} PROJECTS {'\u00b7'} {stats.workflowCount} WORKFLOWS
            </span>
          </div>
          <span className="nx-clip-line" style={{ ...greetingStyle, animationDelay: '80ms' }}>
            {greeting}
            {firstName ? ',' : ''}
          </span>
          {firstName && (
            <span className="nx-clip-line" style={{ ...greetingStyle, animationDelay: '120ms' }}>
              {firstName}
            </span>
          )}
        </div>

        {workflowPct !== null && plan.workflowUsed / plan.workflowLimit! >= PLAN_ALERT_THRESHOLD && (
          <div className="nx-fade-up" style={planBannerStyle}>
            <span style={planBannerPercentCellStyle}>{workflowPct}%</span>
            <span style={planBannerBodyStyle}>
              {plan.workflowUsed} of {plan.workflowLimit} workflows used on the {plan.plan} plan. An Organization plan
              adds seats, roles and unlimited workflows.
            </span>
            <a href="/app/billing" style={planBannerBtnStyle}>
              See plans <span aria-hidden>{'\u2192'}</span>
            </a>
          </div>
        )}

        {/* Subscription Phase 3, Slice 4 — same threshold/shape as the
            workflow banner above; rows and Copilot actions link to Billing
            where the full usage bars + 100%-blocked messaging live. */}
        {rowsPct !== null && plan.rowsUsed / plan.rowsLimit! >= PLAN_ALERT_THRESHOLD && (
          <div className="nx-fade-up" style={planBannerStyle}>
            <span style={planBannerPercentCellStyle}>{rowsPct}%</span>
            <span style={planBannerBodyStyle}>
              {plan.rowsUsed.toLocaleString()} of {plan.rowsLimit!.toLocaleString()} rows used this month on the{' '}
              {plan.plan} plan.
            </span>
            <a href="/app/billing" style={planBannerBtnStyle}>
              See usage <span aria-hidden>{'\u2192'}</span>
            </a>
          </div>
        )}

        {copilotPct !== null && plan.copilotUsed / plan.copilotLimit! >= PLAN_ALERT_THRESHOLD && (
          <div className="nx-fade-up" style={planBannerStyle}>
            <span style={planBannerPercentCellStyle}>{copilotPct}%</span>
            <span style={planBannerBodyStyle}>
              {plan.copilotUsed.toLocaleString()} of {plan.copilotLimit!.toLocaleString()} Copilot actions used this
              month on the {plan.plan} plan.
            </span>
            <a href="/app/billing" style={planBannerBtnStyle}>
              See usage <span aria-hidden>{'\u2192'}</span>
            </a>
          </div>
        )}

        {recentRuns.length === 0 ? (
          <div
            className="nx-fade-up nx-halftone"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              width: '100%',
              boxSizing: 'border-box',
              padding: 40,
              borderBottom: '1px solid var(--nx-line)',
              backgroundSize: '6px 6px',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-inter-tight), var(--nx-font-ui)',
                fontSize: 44,
                fontWeight: 500,
                letterSpacing: '-0.04em',
                color: 'var(--nx-ink)',
              }}
            >
              No runs yet.
            </span>
            <span style={{ fontSize: 17, lineHeight: '26px', color: 'var(--nx-ink-2)' }}>
              Runs will show up here once a workflow executes.
            </span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <KpiStrip aggregate={aggregate} />

            {isEarly ? (
              <>
                <RunsSoFarChart runs={recentRuns} />
                <div
                  className="nx-fade-up"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '200px minmax(0, 1fr)',
                    borderBottom: '1px solid var(--nx-line)',
                  }}
                >
                  <div
                    className="nx-halftone"
                    style={{
                      display: 'flex',
                      alignItems: 'flex-end',
                      padding: 20,
                      borderRight: '1px solid var(--nx-line)',
                      backgroundSize: '6px 6px',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: 'var(--nx-font-ui)',
                        fontSize: 96,
                        fontWeight: 500,
                        letterSpacing: '-0.05em',
                        lineHeight: 0.8,
                        color: 'var(--nx-ink)',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {historyDays}
                      <span style={{ color: 'var(--nx-ink-disabled)' }}>/{EARLY_DAYS_THRESHOLD}</span>
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '24px 24px 24px 32px', justifyContent: 'center' }}>
                    <span
                      style={{
                        fontFamily: 'var(--nx-font-condensed)',
                        fontStretch: '62.5%',
                        fontWeight: 700,
                        fontSize: 16,
                        letterSpacing: '0.04em',
                        textTransform: 'uppercase',
                        color: 'var(--nx-blue-panel)',
                      }}
                    >
                      Days of history
                    </span>
                    <span
                      style={{
                        fontFamily: 'var(--font-inter-tight), var(--nx-font-ui)',
                        fontSize: 30,
                        lineHeight: '34px',
                        fontWeight: 500,
                        letterSpacing: '-0.03em',
                        color: 'var(--nx-ink)',
                      }}
                    >
                      Trends appear after a few days
                    </span>
                    <span style={{ fontSize: 15, lineHeight: '23px', color: 'var(--nx-ink-2)' }}>
                      Runs per day, rows moved and run duration trends show up here once there are at least{' '}
                      {EARLY_DAYS_THRESHOLD} days of runs.
                    </span>
                  </div>
                </div>
              </>
            ) : (
              <>
                <RunsPerDayChart aggregate={aggregate} />
                <TrendCharts aggregate={aggregate} durationSeries={durationSeries} />
              </>
            )}

            <WorkflowsTable rows={workflowRows} />
          </div>
        )}
      </div>
      <RightPanel
        userId={userId}
        fullName={fullName}
        workspaceLabel={workspaceLabel}
        plan={plan}
        needsAttention={needsAttention}
        activity={activity}
      />
    </div>
  );
}
