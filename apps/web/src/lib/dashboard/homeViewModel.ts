/**
 * Pure transforms from the real (limit=50) RecentRun[] list into the shapes
 * the new Home dashboard components render. Deliberately does NOT invent
 * data the backend doesn't provide (connector route names, failure reason
 * strings, "runs this month" quotas, audit-log style activity like "edited
 * workflow") — see docs/decisions.md for the follow-up that would let a
 * backend endpoint supply richer fields later.
 */
import type { DailyBucket } from './aggregate';
import { localDateKey } from './aggregate';
import type { RecentRun, RunStatus } from './types';
import { formatDuration, relativeTime } from '../time';

export type WorkflowRow = {
  workflowId: string;
  workflowName: string;
  /** 'ok' | 'fail' | 'running' derived from the most recent run only — no
   *  write-grant/paused signal exists in RecentRun, so those design states
   *  are intentionally not reproduced. */
  status: 'ok' | 'fail' | 'running';
  statusLabel: string;
  strip: { succeeded: boolean }[];
  stripLabel: string;
  rowsProcessed: number;
  medianDurationMs: number | null;
  lastRunAt: string;
};

export type NeedsAttentionItem = {
  workflowId: string;
  workflowName: string;
  when: string;
};

export type ActivityItem = {
  id: string;
  workflowName: string;
  status: RunStatus;
  meta: string;
  when: string;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Groups the loaded runs by workflow, newest first per group. */
function groupByWorkflow(runs: RecentRun[]): Map<string, RecentRun[]> {
  const map = new Map<string, RecentRun[]>();
  for (const run of runs) {
    const list = map.get(run.workflowId);
    if (list) list.push(run);
    else map.set(run.workflowId, [run]);
  }
  return map;
}

export function buildWorkflowRows(runs: RecentRun[]): WorkflowRow[] {
  const groups = groupByWorkflow(runs);
  const rows: WorkflowRow[] = [];
  for (const [workflowId, workflowRuns] of groups) {
    const sorted = [...workflowRuns].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
    const latest = sorted[0]!; // groupByWorkflow only creates a group when it has >= 1 run
    const status: WorkflowRow['status'] =
      latest.status === 'failed' ? 'fail' : latest.status === 'running' ? 'running' : 'ok';
    const statusLabel = status === 'fail' ? 'Failed' : status === 'running' ? 'Running' : 'Succeeded';
    const stripSource = sorted.slice(0, 20).reverse(); // oldest-of-the-slice first, matches left-to-right time order
    const strip = stripSource.map((r) => ({ succeeded: r.status === 'succeeded' }));
    const failedCount = stripSource.filter((r) => r.status === 'failed').length;
    const rowsProcessed = sorted.reduce((sum, r) => sum + r.rowsProcessed, 0);
    const durations = sorted.map((r) => r.durationMs).filter((d): d is number => d !== null);
    rows.push({
      workflowId,
      workflowName: latest.workflowName,
      status,
      statusLabel,
      strip,
      stripLabel: `${stripSource.length - failedCount} succeeded, ${failedCount} failed (last ${stripSource.length} run${stripSource.length === 1 ? '' : 's'})`,
      rowsProcessed,
      medianDurationMs: median(durations),
      lastRunAt: latest.startedAt,
    });
  }
  return rows.sort((a, b) => new Date(b.lastRunAt).getTime() - new Date(a.lastRunAt).getTime());
}

/** Only real signal available: the workflow's most recent loaded run failed.
 *  No fabricated failure reason — the backend doesn't expose one yet. */
export function buildNeedsAttention(runs: RecentRun[]): NeedsAttentionItem[] {
  const rows = buildWorkflowRows(runs);
  return rows
    .filter((r) => r.status === 'fail')
    .map((r) => ({ workflowId: r.workflowId, workflowName: r.workflowName, when: relativeTime(r.lastRunAt) }));
}

export type DurationPoint = {
  date: string;
  medianMs: number | null;
  /** True only when the date is inside the loaded window AND has at least
   *  one succeeded run with a recorded duration — a chart must not draw a
   *  line through a day where this is false (matches sparklinePath's rule
   *  of only drawing through points the caller marks loaded). No per-day
   *  p95 is derived here: with typically 1-3 runs/day that would imply a
   *  statistical distribution the data doesn't support. The single overall
   *  p95 (aggregate.ts's p95DurationMs, gated at 20+ samples) is the only
   *  p95 shown anywhere in the dashboard. */
  hasData: boolean;
};

/** Buckets succeeded runs' durations by the same local-calendar-day rule as
 *  aggregate.ts (reuses its exported `localDateKey`), so the two stay in
 *  sync. `days` should be the DailyBucket[] from the same DashboardAggregate
 *  call — its `loaded` flag is reused so an unloaded day never renders as
 *  "no runs" or interpolates across the gap. */
export function buildDurationSeries(runs: RecentRun[], days: DailyBucket[]): DurationPoint[] {
  const byDate = new Map<string, number[]>();
  for (const run of runs) {
    if (run.status !== 'succeeded' || run.durationMs === null) continue;
    const key = localDateKey(new Date(run.startedAt));
    const list = byDate.get(key);
    if (list) list.push(run.durationMs);
    else byDate.set(key, [run.durationMs]);
  }
  return days.map((day) => {
    const durations = byDate.get(day.date);
    const medianMs = day.loaded && durations ? median(durations) : null;
    return { date: day.date, medianMs, hasData: day.loaded && durations !== undefined };
  });
}

export function buildActivityFeed(runs: RecentRun[], limit = 5): ActivityItem[] {
  const sorted = [...runs].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  return sorted.slice(0, limit).map((run) => ({
    id: run.id,
    workflowName: run.workflowName,
    status: run.status,
    meta:
      run.status === 'running'
        ? 'in progress'
        : `${run.rowsProcessed.toLocaleString()} rows \u00b7 ${formatDuration(run.durationMs)}`,
    when: relativeTime(run.startedAt),
  }));
}
