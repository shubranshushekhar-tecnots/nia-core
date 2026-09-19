'use client';

import type { ContinueWorkflow, DashboardStats, RecentRun } from '@/lib/dashboard/types';
import type { PlanUsage } from '@/lib/billing/plan';
import { formatDuration, relativeTime } from '@/lib/time';
import {
  cardMetaStyle,
  cardTitleStyle,
  continueCardStyle,
  continueLabelStyle,
  emptyStateStyle,
  greetingLineStyle,
  greetingStyle,
  homeScrollStyle,
  planBannerBtnStyle,
  planBannerStyle,
  runMetaStyle,
  runRowStyle,
  runStatusTextStyle,
  runsSectionTitleStyle,
  statusDotStyle,
} from './styles';

export default function HomeContent({
  greeting,
  fullName,
  continueWorkflow,
  recentRuns,
  plan,
  stats,
}: {
  greeting: string;
  fullName: string | null;
  continueWorkflow: ContinueWorkflow | null;
  recentRuns: RecentRun[];
  plan: PlanUsage;
  stats: DashboardStats;
}) {
  const showPlanLimit = plan.used / plan.limit >= 0.8;
  const firstName = fullName?.trim().split(/\s+/)[0];

  return (
    <div style={homeScrollStyle}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ ...greetingStyle, fontWeight: 500 }}>
          {greeting}{firstName ? `, ${firstName}` : ''}
        </span>
        <span style={greetingLineStyle}>
          Your workspace {'\u00b7'} {stats.projectCount} projects {'\u00b7'} {stats.workflowCount} workflows
        </span>
      </div>

      {continueWorkflow && (
        <div style={continueCardStyle}>
          <span style={continueLabelStyle}>Continue</span>
          <span style={cardTitleStyle}>{continueWorkflow.name}</span>
          <span style={cardMetaStyle}>
            {continueWorkflow.projectName} {'\u00b7'} edited {relativeTime(continueWorkflow.updatedAt)}
          </span>
        </div>
      )}

      {showPlanLimit && (
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

      <div>
        <div style={runsSectionTitleStyle}>Your recent runs</div>
        {recentRuns.length === 0 ? (
          <div style={emptyStateStyle}>
            <span>No runs yet.</span>
            <span>Runs will show up here once a workflow executes.</span>
          </div>
        ) : (
          recentRuns.map((run) => (
            <div key={run.id} style={runRowStyle}>
              <span style={statusDotStyle(run.status)} aria-hidden />
              <span style={{ fontSize: 13.5, color: 'var(--text)' }}>{run.workflowName}</span>
              <span style={runStatusTextStyle(run.status)}>{run.status}</span>
              <span style={runMetaStyle}>
                {run.rowsProcessed.toLocaleString()} rows {'\u00b7'} {formatDuration(run.durationMs)} {'\u00b7'}{' '}
                {relativeTime(run.startedAt)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
