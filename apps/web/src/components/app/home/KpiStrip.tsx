import type { CSSProperties } from 'react';
import type { DashboardAggregate, KpiDelta } from '@/lib/dashboard/aggregate';
import { formatDuration } from '@/lib/time';
import { sparklinePath } from './sparkline';

const cellStyle = (i: number): CSSProperties => ({
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '18px 20px',
  borderRight: i < 3 ? '1px solid var(--line-100)' : undefined,
});

function DeltaBadge({ delta, goodWhenUp }: { delta: KpiDelta; goodWhenUp: boolean }) {
  if (!delta.deltaAvailable || delta.deltaValue === null) return null;
  const up = delta.deltaValue >= 0;
  const good = up === goodWhenUp;
  return (
    <span
      style={{
        fontSize: 12,
        fontWeight: 500,
        color: good ? 'var(--success)' : 'var(--danger)',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {up ? '\u2191' : '\u2193'} {Math.abs(delta.deltaValue).toLocaleString()}
    </span>
  );
}

function Spark({ values }: { values: number[] }) {
  const path = sparklinePath(values);
  if (!path) return <svg width={96} height={32} aria-hidden />;
  return (
    <svg width={96} height={32} viewBox="0 0 96 32" aria-hidden="true">
      <path d={path.area} fill="var(--acc)" fillOpacity={0.08} stroke="none" />
      <path d={path.line} fill="none" stroke="var(--acc)" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export default function KpiStrip({ aggregate }: { aggregate: DashboardAggregate }) {
  const loadedDays = aggregate.days.filter((d) => d.loaded);
  const runsSpark = loadedDays.map((d) => d.succeeded + d.failed);
  const rateSpark = loadedDays.map((d) => (d.succeeded + d.failed === 0 ? 0 : (100 * d.succeeded) / (d.succeeded + d.failed)));
  const rowsSpark = loadedDays.map((d) => d.rowsProcessed);

  const successRatePct =
    aggregate.kpis.runs.value === 0 ? 0 : Math.round((aggregate.kpis.successRatePct.value + Number.EPSILON) * 10) / 10;

  const windowLabel = aggregate.truncated
    ? `Based on the latest ${aggregate.fetchLimit} runs (last ${aggregate.windowDays} day${aggregate.windowDays === 1 ? '' : 's'})`
    : 'All runs';

  return (
    <section
      aria-label="Key numbers"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
        background: 'var(--surface)',
        border: '1px solid var(--line-100)',
        borderRadius: 12,
      }}
    >
      <div style={cellStyle(0)}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12.5, color: 'var(--ink-200)' }}>Runs</span>
          <DeltaBadge delta={aggregate.kpis.runs} goodWhenUp />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ fontSize: 28, lineHeight: '34px', fontWeight: 500, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>
            {aggregate.kpis.runs.value.toLocaleString()}
          </span>
          <Spark values={runsSpark} />
        </div>
        <span style={{ fontSize: 12, color: 'var(--ink-300)' }}>{windowLabel}</span>
      </div>

      <div style={cellStyle(1)}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12.5, color: 'var(--ink-200)' }}>Success rate</span>
          <DeltaBadge delta={aggregate.kpis.successRatePct} goodWhenUp />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ fontSize: 28, lineHeight: '34px', fontWeight: 500, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>
            {aggregate.kpis.runs.value === 0 ? '\u2014' : `${successRatePct}%`}
          </span>
          <Spark values={rateSpark} />
        </div>
        <span style={{ fontSize: 12, color: 'var(--ink-300)' }}>
          {aggregate.kpis.runs.value === 0 ? 'No runs loaded yet' : `${aggregate.days.reduce((s, d) => s + d.failed, 0)} failed runs`}
        </span>
      </div>

      <div style={cellStyle(2)}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12.5, color: 'var(--ink-200)' }}>Rows moved</span>
          <DeltaBadge delta={aggregate.kpis.rowsMoved} goodWhenUp />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ fontSize: 28, lineHeight: '34px', fontWeight: 500, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>
            {aggregate.kpis.rowsMoved.value.toLocaleString()}
          </span>
          <Spark values={rowsSpark} />
        </div>
        <span style={{ fontSize: 12, color: 'var(--ink-300)' }}>{windowLabel}</span>
      </div>

      <div style={cellStyle(3)}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12.5, color: 'var(--ink-200)' }}>Median run time</span>
          <DeltaBadge delta={aggregate.kpis.medianDurationMs} goodWhenUp={false} />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ fontSize: 28, lineHeight: '34px', fontWeight: 500, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>
            {formatDuration(aggregate.kpis.medianDurationMs.value || null)}
          </span>
        </div>
        <span style={{ fontSize: 12, color: 'var(--ink-300)' }}>
          {aggregate.p95DurationMs.value !== null
            ? `Slowest 5%: ${formatDuration(aggregate.p95DurationMs.value)}`
            : 'Not enough runs yet for p95'}
        </span>
      </div>
    </section>
  );
}
