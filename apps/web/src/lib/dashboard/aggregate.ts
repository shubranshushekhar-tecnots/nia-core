/**
 * Client-side aggregation over the existing `GET /dashboard/recent-runs`
 * response — no new backend endpoint (see docs/decisions.md for the
 * follow-up: a real `GET /dashboard/summary` SQL aggregate). The route
 * hard-caps `limit` at 50 (apps/api/src/routes/dashboard.ts), so a busy
 * workspace's fetch can be truncated well short of the 28 days this
 * module would like to see (14-day KPI window + its comparison period).
 * Every function here is honest about that instead of pretending the
 * loaded rows are the whole story:
 *  - `truncated` is true whenever the fetch hit the cap (there may be
 *    more, older runs not loaded).
 *  - a day bucket outside the loaded window is `loaded: false` ("no data
 *    loaded"), never presented as a real zero-runs day.
 *  - KPI deltas are only returned when the loaded window fully covers
 *    both the current and previous 14-day periods; otherwise
 *    `deltaAvailable` is false and callers must hide the delta.
 *  - p95 duration is only returned with >= P95_MIN_SAMPLE succeeded runs
 *    in the current period; otherwise `reason: 'insufficient-data'`.
 *
 * All day bucketing uses the *local* calendar day (Date's local getters),
 * not UTC, per the product decision that a run just after local midnight
 * belongs to "today", not "yesterday in UTC".
 */
import type { RecentRun } from './types';

const AXIS_DAYS = 14;
const P95_MIN_SAMPLE = 20;

export type DailyBucket = {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  succeeded: number;
  failed: number;
  rowsProcessed: number;
  /** Whether this date falls within the loaded window — false means "no
   *  data loaded" (unknown), distinct from a real zero-runs day. */
  loaded: boolean;
};

export type KpiDelta = {
  value: number;
  /** False when the loaded window doesn't fully cover both the current
   *  and previous 14-day periods — callers must hide the delta, not show
   *  a delta computed from partial data. */
  deltaAvailable: boolean;
  deltaValue: number | null;
  deltaPct: number | null;
};

export type P95Result =
  | { value: number; sampleSize: number }
  | { value: null; sampleSize: number; reason: 'insufficient-data' };

export type DashboardAggregate = {
  truncated: boolean;
  runsLoaded: number;
  fetchLimit: number;
  /** Calendar days spanned by the loaded window (oldest loaded run's
   *  local date through today, inclusive). 0 when there are no runs. */
  windowDays: number;
  /** 14 entries, oldest first, today last. */
  days: DailyBucket[];
  kpis: {
    runs: KpiDelta;
    successRatePct: KpiDelta;
    rowsMoved: KpiDelta;
    medianDurationMs: KpiDelta;
  };
  p95DurationMs: P95Result;
};

/** Exported so callers building derived per-day series (e.g. a duration
 *  chart) bucket by the exact same local-calendar-day rule as this module. */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, delta: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + delta);
  return copy;
}

function daysBetween(a: string, b: string): number {
  // Both are YYYY-MM-DD local date keys; diff via local-midnight Dates so
  // DST transitions in between don't skew the day count.
  const [ay, am, ad] = a.split('-').map(Number) as [number, number, number];
  const [by, bm, bd] = b.split('-').map(Number) as [number, number, number];
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((new Date(by, bm - 1, bd).getTime() - new Date(ay, am - 1, ad).getTime()) / msPerDay);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Nearest-rank percentile (p in [0, 100]) over a pre-sorted ascending array. */
function percentile(sortedAsc: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sortedAsc.length) - 1;
  return sortedAsc[Math.max(0, Math.min(sortedAsc.length - 1, rank))]!;
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function delta(current: number, previous: number, available: boolean): KpiDelta {
  return {
    value: current,
    deltaAvailable: available,
    deltaValue: available ? current - previous : null,
    deltaPct: available && previous !== 0 ? ((current - previous) / previous) * 100 : null,
  };
}

export function aggregateDashboard(runs: RecentRun[], fetchLimit: number, now: Date = new Date()): DashboardAggregate {
  const truncated = runs.length >= fetchLimit;
  const today = startOfLocalDay(now);

  const oldestLoadedDate =
    runs.length === 0
      ? null
      : runs.reduce<string | null>((oldest, run) => {
          const key = localDateKey(new Date(run.startedAt));
          return oldest === null || key < oldest ? key : oldest;
        }, null);

  const windowDays = oldestLoadedDate ? daysBetween(oldestLoadedDate, localDateKey(today)) + 1 : 0;

  // 14-day chart axis, oldest first.
  const axisKeys: string[] = [];
  for (let i = AXIS_DAYS - 1; i >= 0; i--) {
    axisKeys.push(localDateKey(addDays(today, -i)));
  }

  const byDate = new Map<string, { succeeded: number; failed: number; rowsProcessed: number }>();
  for (const run of runs) {
    const key = localDateKey(new Date(run.startedAt));
    const bucket = byDate.get(key) ?? { succeeded: 0, failed: 0, rowsProcessed: 0 };
    if (run.status === 'succeeded') bucket.succeeded += 1;
    if (run.status === 'failed') bucket.failed += 1;
    bucket.rowsProcessed += run.rowsProcessed;
    byDate.set(key, bucket);
  }

  const days: DailyBucket[] = axisKeys.map((date) => {
    const loaded = !truncated || (oldestLoadedDate !== null && date >= oldestLoadedDate);
    const bucket = byDate.get(date);
    return {
      date,
      succeeded: bucket?.succeeded ?? 0,
      failed: bucket?.failed ?? 0,
      rowsProcessed: bucket?.rowsProcessed ?? 0,
      loaded,
    };
  });

  // Current 14-day period vs the previous 14-day period (28 days total).
  const currentStart = localDateKey(addDays(today, -(AXIS_DAYS - 1)));
  const currentEnd = localDateKey(today);
  const previousStart = localDateKey(addDays(today, -(2 * AXIS_DAYS - 1)));
  const previousEnd = localDateKey(addDays(today, -AXIS_DAYS));

  const bothPeriodsCovered = !truncated || (oldestLoadedDate !== null && oldestLoadedDate <= previousStart);

  const inRange = (key: string, start: string, end: string) => key >= start && key <= end;
  const currentRuns = runs.filter((r) => inRange(localDateKey(new Date(r.startedAt)), currentStart, currentEnd));
  const previousRuns = runs.filter((r) => inRange(localDateKey(new Date(r.startedAt)), previousStart, previousEnd));

  const currentSucceeded = currentRuns.filter((r) => r.status === 'succeeded').length;
  const previousSucceeded = previousRuns.filter((r) => r.status === 'succeeded').length;
  const currentSuccessRate = currentRuns.length ? (currentSucceeded / currentRuns.length) * 100 : 0;
  const previousSuccessRate = previousRuns.length ? (previousSucceeded / previousRuns.length) * 100 : 0;
  const currentRows = sum(currentRuns.map((r) => r.rowsProcessed));
  const previousRows = sum(previousRuns.map((r) => r.rowsProcessed));
  const currentDurations = currentRuns.map((r) => r.durationMs).filter((d): d is number => d != null);
  const previousDurations = previousRuns.map((r) => r.durationMs).filter((d): d is number => d != null);
  const currentMedian = median(currentDurations) ?? 0;
  const previousMedian = median(previousDurations) ?? 0;

  const succeededDurationsAsc = currentRuns
    .filter((r) => r.status === 'succeeded')
    .map((r) => r.durationMs)
    .filter((d): d is number => d != null)
    .sort((a, b) => a - b);

  const p95DurationMs: P95Result =
    succeededDurationsAsc.length >= P95_MIN_SAMPLE
      ? { value: percentile(succeededDurationsAsc, 95), sampleSize: succeededDurationsAsc.length }
      : { value: null, sampleSize: succeededDurationsAsc.length, reason: 'insufficient-data' };

  return {
    truncated,
    runsLoaded: runs.length,
    fetchLimit,
    windowDays,
    days,
    kpis: {
      runs: delta(currentRuns.length, previousRuns.length, bothPeriodsCovered),
      successRatePct: delta(currentSuccessRate, previousSuccessRate, bothPeriodsCovered),
      rowsMoved: delta(currentRows, previousRows, bothPeriodsCovered),
      medianDurationMs: delta(currentMedian, previousMedian, bothPeriodsCovered),
    },
    p95DurationMs,
  };
}
