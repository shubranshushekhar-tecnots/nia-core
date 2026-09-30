'use client';

import type { DashboardStats, RecentRun } from '@/lib/dashboard/types';
import { PLAN_ALERT_THRESHOLD, type PlanUsage } from '@/lib/billing/plan';
import { aggregateDashboard } from '@/lib/dashboard/aggregate';
import { buildActivityFeed, buildDurationSeries, buildNeedsAttention, buildWorkflowRows } from '@/lib/dashboard/homeViewModel';
import {
  greetingLineStyle,
  greetingStyle,
  homeScrollStyle,
  nxGreetingTagStyle,
  planBannerBtnStyle,
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

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <div style={homeScrollStyle}>
        <div className="nx-fade-up" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span className="nx-clip-line" style={nxGreetingTagStyle}>
            Your workspace
          </span>
          <span className="nx-clip-line" style={{ ...greetingStyle, animationDelay: '80ms' }}>
            {greeting}
            {firstName ? (
              <>
                {', '}
                <span style={{ color: 'var(--nx-blue-panel)' }}>{firstName}</span>
              </>
            ) : (
              ''
            )}
          </span>
          <span style={greetingLineStyle}>
            {stats.projectCount} PROJECTS {'\u00b7'} {stats.workflowCount} WORKFLOWS
          </span>
        </div>

        {plan.workflowLimit !== null && plan.workflowUsed / plan.workflowLimit >= PLAN_ALERT_THRESHOLD && (
          <div className="nx-fade-up" style={planBannerStyle}>
            <span>
              {plan.workflowUsed} of {plan.workflowLimit} workflows used on the {plan.plan} plan. An Organization plan
              adds seats, roles and unlimited workflows.
            </span>
            <a href="/app/billing" style={{ textDecoration: 'none' }}>
              <button type="button" style={planBannerBtnStyle}>
                See plans
              </button>
            </a>
          </div>
        )}

        {/* Subscription Phase 3, Slice 4 — same threshold/shape as the
            workflow banner above; rows and Copilot actions link to Billing
            where the full usage bars + 100%-blocked messaging live. */}
        {plan.rowsLimit !== null && plan.rowsUsed / plan.rowsLimit >= PLAN_ALERT_THRESHOLD && (
          <div className="nx-fade-up" style={planBannerStyle}>
            <span>
              {plan.rowsUsed.toLocaleString()} of {plan.rowsLimit.toLocaleString()} rows used this month on the{' '}
              {plan.plan} plan.
            </span>
            <a href="/app/billing" style={{ textDecoration: 'none' }}>
              <button type="button" style={planBannerBtnStyle}>
                See usage
              </button>
            </a>
          </div>
        )}

        {plan.copilotLimit !== null && plan.copilotUsed / plan.copilotLimit >= PLAN_ALERT_THRESHOLD && (
          <div className="nx-fade-up" style={planBannerStyle}>
            <span>
              {plan.copilotUsed.toLocaleString()} of {plan.copilotLimit.toLocaleString()} Copilot actions used this
              month on the {plan.plan} plan.
            </span>
            <a href="/app/billing" style={{ textDecoration: 'none' }}>
              <button type="button" style={planBannerBtnStyle}>
                See usage
              </button>
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
              padding: '48px 32px',
              borderRadius: 'var(--nx-radius)',
              border: '1px solid var(--nx-line)',
              background: 'var(--nx-surface)',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--nx-font-ui)',
                fontSize: 44,
                fontWeight: 700,
                letterSpacing: '-0.035em',
                color: 'var(--nx-ink)',
              }}
            >
              No runs yet.
            </span>
            <span style={{ fontSize: 13.5, color: 'var(--nx-ink-2)' }}>Runs will show up here once a workflow executes.</span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <KpiStrip aggregate={aggregate} />

            {isEarly ? (
              <div
                className="nx-fade-up"
                style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 300px', gap: 32, alignItems: 'center' }}
              >
                <RunsSoFarChart runs={recentRuns} />
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 14,
                    padding: 20,
                    borderRadius: 'var(--nx-radius)',
                    background: 'var(--nx-surface)',
                    border: '1px solid var(--nx-line)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                    <span
                      style={{
                        fontFamily: 'var(--nx-font-ui)',
                        fontSize: 36,
                        fontWeight: 700,
                        letterSpacing: '-0.03em',
                        color: 'var(--nx-ink)',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {historyDays}
                    </span>
                    <span style={{ fontFamily: 'var(--nx-font-mono)', fontSize: 16, color: 'var(--nx-ink-3)' }}>
                      /{EARLY_DAYS_THRESHOLD}
                    </span>
                  </div>
                  <span style={{ ...nxGreetingTagStyle, fontSize: 11 }}>Days of history</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--nx-ink)' }}>Trends appear after a few days</span>
                  <span style={{ fontSize: 12.5, lineHeight: '18px', color: 'var(--nx-ink-2)' }}>
                    Runs per day, rows moved and run duration trends show up here once there are at least{' '}
                    {EARLY_DAYS_THRESHOLD} days of runs.
                  </span>
                </div>
              </div>
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
