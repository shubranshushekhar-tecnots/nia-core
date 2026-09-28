'use client';

import type { DashboardStats, RecentRun } from '@/lib/dashboard/types';
import type { PlanUsage } from '@/lib/billing/plan';
import { aggregateDashboard } from '@/lib/dashboard/aggregate';
import { buildActivityFeed, buildDurationSeries, buildNeedsAttention, buildWorkflowRows } from '@/lib/dashboard/homeViewModel';
import { greetingLineStyle, greetingStyle, homeScrollStyle, planBannerBtnStyle, planBannerStyle } from './styles';
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

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <div style={homeScrollStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ ...greetingStyle, fontWeight: 500 }}>
            {greeting}
            {firstName ? `, ${firstName}` : ''}
          </span>
          <span style={greetingLineStyle}>
            Your workspace {'\u00b7'} {stats.projectCount} projects {'\u00b7'} {stats.workflowCount} workflows
          </span>
        </div>

        {plan.used / plan.limit >= 0.8 && (
          <div style={planBannerStyle}>
            <span>
              {plan.used} of {plan.limit} workflows used on the {plan.plan} plan. An Organization plan adds seats, roles
              and unlimited workflows.
            </span>
            <a href="/app/billing" style={{ textDecoration: 'none' }}>
              <button type="button" style={planBannerBtnStyle}>
                See plans
              </button>
            </a>
          </div>
        )}

        {recentRuns.length === 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              padding: '32px 24px',
              borderRadius: 12,
              background: 'var(--surface)',
              border: '1px solid var(--line-100)',
              color: 'var(--ink-200)',
              fontSize: 13.5,
            }}
          >
            <span>No runs yet.</span>
            <span>Runs will show up here once a workflow executes.</span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <KpiStrip aggregate={aggregate} />

            {isEarly ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 300px', gap: 32, alignItems: 'center' }}>
                <RunsSoFarChart runs={recentRuns} />
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                    padding: 20,
                    borderRadius: 10,
                    background: 'var(--acc-soft)',
                    border: '1px solid var(--acc-soft-bd, var(--line-200))',
                  }}
                >
                  <span style={{ fontSize: 14, fontWeight: 600 }}>Trends appear after a few days</span>
                  <span style={{ fontSize: 12.5, lineHeight: '18px', color: 'var(--ink-200)' }}>
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
