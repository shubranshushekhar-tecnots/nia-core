import { describe, expect, it } from 'vitest';
import { aggregateDashboard } from './aggregate';
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

// Fixed "now": Sep 28 2026, 12:00 local. All test dates are relative to this.
const NOW = new Date(2026, 8, 28, 12, 0, 0);

function daysAgoIso(n: number, hour = 10): string {
  const d = new Date(NOW);
  d.setDate(d.getDate() - n);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

describe('aggregateDashboard — day bucketing', () => {
  it('buckets by local calendar day, not UTC', () => {
    // Set the process timezone so Date's local getters are non-UTC and
    // deterministic for this test, independent of the host machine.
    const originalTz = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      // 11:30pm Pacific on "yesterday" is 7:30am UTC "today" — a run here
      // must bucket into yesterday's local day, not today's UTC day.
      const now = new Date('2024-01-16T12:00:00-08:00');
      const run = mkRun({ startedAt: '2024-01-15T23:30:00-08:00' });
      const result = aggregateDashboard([run], 50, now);
      const yesterday = result.days[result.days.length - 2]!;
      const today = result.days[result.days.length - 1]!;
      expect(yesterday.date).toBe('2024-01-15');
      expect(yesterday.succeeded).toBe(1);
      expect(today.succeeded).toBe(0);
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it('produces 14 day buckets, oldest first, today last', () => {
    const result = aggregateDashboard([], 50, NOW);
    expect(result.days).toHaveLength(14);
    expect(result.days[13]!.date).toBe('2026-09-28');
    expect(result.days[0]!.date).toBe('2026-09-15');
  });
});

describe('aggregateDashboard — truncation', () => {
  it('flags truncated when the fetch hit the limit', () => {
    const runs = Array.from({ length: 50 }, (_, i) => mkRun({ startedAt: daysAgoIso(i % 5) }));
    const result = aggregateDashboard(runs, 50, NOW);
    expect(result.truncated).toBe(true);
    expect(result.runsLoaded).toBe(50);
  });

  it('is not truncated when fewer runs than the limit were returned', () => {
    const runs = [mkRun({ startedAt: daysAgoIso(0) })];
    const result = aggregateDashboard(runs, 50, NOW);
    expect(result.truncated).toBe(false);
  });
});

describe('aggregateDashboard — zero runs', () => {
  it('reports zero everywhere and no window, without crashing', () => {
    const result = aggregateDashboard([], 50, NOW);
    expect(result.runsLoaded).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.windowDays).toBe(0);
    expect(result.days.every((d) => d.succeeded === 0 && d.failed === 0 && d.loaded)).toBe(true);
    expect(result.kpis.runs.value).toBe(0);
    expect(result.p95DurationMs.value).toBeNull();
  });
});

describe('aggregateDashboard — window shorter than 14 days', () => {
  it('marks every axis day as loaded (real zero, not missing) when not truncated', () => {
    const runs = [mkRun({ startedAt: daysAgoIso(0) }), mkRun({ startedAt: daysAgoIso(0) })];
    const result = aggregateDashboard(runs, 50, NOW);
    expect(result.truncated).toBe(false);
    expect(result.windowDays).toBe(1);
    // Every day in the 14-day axis is "loaded" (known-complete), even the
    // 13 days before the org's only run — they're real zeros, not gaps.
    expect(result.days.every((d) => d.loaded)).toBe(true);
    const today = result.days[result.days.length - 1]!;
    expect(today.succeeded).toBe(2);
  });
});

describe('aggregateDashboard — no-data-loaded vs zero-runs', () => {
  it('marks days before the loaded window as loaded:false, distinct from real zeros', () => {
    // 50 runs (hits the cap) all within the last 2 days — a very busy
    // workspace where the fetch never reached further back.
    const runs = Array.from({ length: 50 }, (_, i) => mkRun({ startedAt: daysAgoIso(i % 2) }));
    const result = aggregateDashboard(runs, 50, NOW);
    expect(result.truncated).toBe(true);

    const recentDays = result.days.slice(-2);
    expect(recentDays.every((d) => d.loaded)).toBe(true);

    const olderDays = result.days.slice(0, -2);
    expect(olderDays.every((d) => d.loaded === false)).toBe(true);
  });
});

describe('aggregateDashboard — KPI deltas', () => {
  it('computes deltas when the loaded window fully covers both 14-day periods', () => {
    const currentRuns = Array.from({ length: 10 }, () => mkRun({ startedAt: daysAgoIso(2), rowsProcessed: 100 }));
    const previousRuns = Array.from({ length: 5 }, () => mkRun({ startedAt: daysAgoIso(20), rowsProcessed: 100 }));
    const result = aggregateDashboard([...currentRuns, ...previousRuns], 50, NOW);
    expect(result.truncated).toBe(false);
    expect(result.kpis.runs.deltaAvailable).toBe(true);
    expect(result.kpis.runs.value).toBe(10);
    expect(result.kpis.runs.deltaValue).toBe(5);
    expect(result.kpis.runs.deltaPct).toBe(100);
  });

  it('hides deltas when the loaded window does not reach back far enough to cover the previous period', () => {
    // Truncated fetch that only reaches 5 days back — can't see the
    // previous-14-day comparison period at all.
    const runs = Array.from({ length: 50 }, (_, i) => mkRun({ startedAt: daysAgoIso(i % 5) }));
    const result = aggregateDashboard(runs, 50, NOW);
    expect(result.truncated).toBe(true);
    expect(result.kpis.runs.deltaAvailable).toBe(false);
    expect(result.kpis.runs.deltaValue).toBeNull();
    expect(result.kpis.runs.deltaPct).toBeNull();
    // The raw current-period value is still reported (disclosed via the
    // truncation banner elsewhere), just not compared to the previous period.
    expect(result.kpis.runs.value).toBe(50);
  });
});

describe('aggregateDashboard — p95 duration', () => {
  it('returns "insufficient-data" with fewer than 20 succeeded runs', () => {
    const runs = Array.from({ length: 5 }, () => mkRun({ startedAt: daysAgoIso(1), durationMs: 5000 }));
    const result = aggregateDashboard(runs, 50, NOW);
    expect(result.p95DurationMs.value).toBeNull();
    expect(result.p95DurationMs.sampleSize).toBe(5);
    expect(result.p95DurationMs).toMatchObject({ reason: 'insufficient-data' });
  });

  it('computes a p95 value with 20+ succeeded runs', () => {
    const runs = Array.from({ length: 25 }, (_, i) => mkRun({ startedAt: daysAgoIso(1), durationMs: (i + 1) * 1000 }));
    const result = aggregateDashboard(runs, 50, NOW);
    expect(result.p95DurationMs.value).not.toBeNull();
    expect(result.p95DurationMs.sampleSize).toBe(25);
  });
});
