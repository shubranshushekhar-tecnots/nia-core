import { describe, expect, it } from 'vitest';
import { aggregateDashboard } from './aggregate';
import { buildActivityFeed, buildDurationSeries, buildNeedsAttention, buildWorkflowRows } from './homeViewModel';
import type { RecentRun } from './types';

let seq = 0;
function mkRun(overrides: Partial<RecentRun> & { startedAt: string }): RecentRun {
  seq += 1;
  return {
    id: `run-${seq}`,
    status: 'succeeded',
    workflowId: 'wf-1',
    workflowName: 'test workflow',
    rowsProcessed: 100,
    durationMs: 5000,
    ...overrides,
  };
}

// Fixed "now": Sep 28 2026, 12:00 local — matches aggregate.test.ts's fixture.
const NOW = new Date(2026, 8, 28, 12, 0, 0);

function daysAgoIso(n: number, hour = 10): string {
  const d = new Date(NOW);
  d.setDate(d.getDate() - n);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

describe('buildWorkflowRows', () => {
  it('derives status from the most recent run only', () => {
    const runs = [
      mkRun({ workflowId: 'wf-1', status: 'failed', startedAt: daysAgoIso(0) }),
      mkRun({ workflowId: 'wf-1', status: 'succeeded', startedAt: daysAgoIso(1) }),
    ];
    const rows = buildWorkflowRows(runs);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('fail');
    expect(rows[0]!.statusLabel).toBe('Failed');
  });

  it('sums rowsProcessed across all loaded runs and computes median duration', () => {
    const runs = [
      mkRun({ workflowId: 'wf-1', rowsProcessed: 100, durationMs: 1000, startedAt: daysAgoIso(0) }),
      mkRun({ workflowId: 'wf-1', rowsProcessed: 200, durationMs: 3000, startedAt: daysAgoIso(1) }),
      mkRun({ workflowId: 'wf-1', rowsProcessed: 300, durationMs: 2000, startedAt: daysAgoIso(2) }),
    ];
    const rows = buildWorkflowRows(runs);
    expect(rows[0]!.rowsProcessed).toBe(600);
    expect(rows[0]!.medianDurationMs).toBe(2000);
  });

  it('builds an honest stripLabel that reflects only the runs actually in the strip', () => {
    const runs = [
      mkRun({ workflowId: 'wf-1', status: 'succeeded', startedAt: daysAgoIso(0) }),
      mkRun({ workflowId: 'wf-1', status: 'failed', startedAt: daysAgoIso(1) }),
      mkRun({ workflowId: 'wf-1', status: 'succeeded', startedAt: daysAgoIso(2) }),
    ];
    const rows = buildWorkflowRows(runs);
    expect(rows[0]!.strip).toHaveLength(3);
    expect(rows[0]!.stripLabel).toBe('2 succeeded, 1 failed (last 3 runs)');
  });

  it('caps the strip at the last 20 runs, oldest-of-the-slice first', () => {
    const runs = Array.from({ length: 25 }, (_, i) => mkRun({ workflowId: 'wf-1', startedAt: daysAgoIso(i) }));
    const rows = buildWorkflowRows(runs);
    expect(rows[0]!.strip).toHaveLength(20);
    expect(rows[0]!.stripLabel).toContain('last 20 runs');
  });

  it('returns one row per distinct workflowId, sorted by most recent activity', () => {
    const runs = [
      mkRun({ workflowId: 'wf-old', startedAt: daysAgoIso(5) }),
      mkRun({ workflowId: 'wf-new', startedAt: daysAgoIso(0) }),
    ];
    const rows = buildWorkflowRows(runs);
    expect(rows.map((r) => r.workflowId)).toEqual(['wf-new', 'wf-old']);
  });
});

describe('buildNeedsAttention', () => {
  it('surfaces only workflows whose most recent run failed, with no fabricated reason', () => {
    const runs = [
      mkRun({ workflowId: 'wf-ok', status: 'succeeded', startedAt: daysAgoIso(0) }),
      mkRun({ workflowId: 'wf-bad', status: 'failed', workflowName: 'broken flow', startedAt: daysAgoIso(0) }),
    ];
    const items = buildNeedsAttention(runs);
    expect(items).toHaveLength(1);
    expect(items[0]!).toEqual({ workflowId: 'wf-bad', workflowName: 'broken flow', when: expect.any(String) });
  });

  it('excludes a workflow that failed previously but has since recovered', () => {
    const runs = [
      mkRun({ workflowId: 'wf-1', status: 'succeeded', startedAt: daysAgoIso(0) }),
      mkRun({ workflowId: 'wf-1', status: 'failed', startedAt: daysAgoIso(1) }),
    ];
    expect(buildNeedsAttention(runs)).toHaveLength(0);
  });
});

describe('buildActivityFeed', () => {
  it('maps real run-completion events only, newest first, capped at the limit', () => {
    const runs = Array.from({ length: 8 }, (_, i) => mkRun({ startedAt: daysAgoIso(i), rowsProcessed: i }));
    const feed = buildActivityFeed(runs, 5);
    expect(feed).toHaveLength(5);
    expect(feed[0]!.meta).toContain('0 rows');
  });

  it('shows "in progress" for a running run instead of a fabricated duration', () => {
    const runs = [mkRun({ status: 'running', durationMs: null, startedAt: daysAgoIso(0) })];
    const feed = buildActivityFeed(runs);
    expect(feed[0]!.meta).toBe('in progress');
  });
});

describe('buildDurationSeries', () => {
  it('computes a per-day median only for loaded days with succeeded, timed runs', () => {
    const runs = [
      mkRun({ status: 'succeeded', durationMs: 1000, startedAt: daysAgoIso(0) }),
      mkRun({ status: 'succeeded', durationMs: 3000, startedAt: daysAgoIso(0) }),
    ];
    const aggregate = aggregateDashboard(runs, 50, NOW);
    const series = buildDurationSeries(runs, aggregate.days);
    const today = series[series.length - 1]!;
    expect(today.hasData).toBe(true);
    expect(today.medianMs).toBe(2000);
  });

  it('excludes failed and running runs from the median (no duration signal to fabricate)', () => {
    const runs = [
      mkRun({ status: 'succeeded', durationMs: 1000, startedAt: daysAgoIso(0) }),
      mkRun({ status: 'failed', durationMs: 9000, startedAt: daysAgoIso(0) }),
      mkRun({ status: 'running', durationMs: null, startedAt: daysAgoIso(0) }),
    ];
    const aggregate = aggregateDashboard(runs, 50, NOW);
    const series = buildDurationSeries(runs, aggregate.days);
    const today = series[series.length - 1]!;
    expect(today.medianMs).toBe(1000);
  });

  it('marks a day with zero succeeded runs as hasData: false, not medianMs: 0', () => {
    const runs = [mkRun({ status: 'succeeded', durationMs: 1000, startedAt: daysAgoIso(0) })];
    const aggregate = aggregateDashboard(runs, 50, NOW);
    const series = buildDurationSeries(runs, aggregate.days);
    const yesterday = series[series.length - 2]!;
    expect(yesterday.hasData).toBe(false);
    expect(yesterday.medianMs).toBeNull();
  });

  it('never reports data for a day outside the loaded (truncated) window', () => {
    // 50 runs all on "day 0" exhausts the fetch cap — day -1 falls outside
    // the loaded window even though, coincidentally, no run happened there.
    const runs = Array.from({ length: 50 }, () =>
      mkRun({ status: 'succeeded', durationMs: 1000, startedAt: daysAgoIso(0) }),
    );
    const aggregate = aggregateDashboard(runs, 50, NOW);
    const series = buildDurationSeries(runs, aggregate.days);
    const dayBefore = series[series.length - 2]!;
    expect(aggregate.days[aggregate.days.length - 2]!.loaded).toBe(false);
    expect(dayBefore.hasData).toBe(false);
    expect(dayBefore.medianMs).toBeNull();
  });

  it('produces one point per day in the input axis, in the same order', () => {
    const aggregate = aggregateDashboard([], 50, NOW);
    const series = buildDurationSeries([], aggregate.days);
    expect(series.map((p) => p.date)).toEqual(aggregate.days.map((d) => d.date));
  });
});
