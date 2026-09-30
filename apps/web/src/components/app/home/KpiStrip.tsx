import type { CSSProperties } from 'react';
import type { DashboardAggregate, KpiDelta } from '@/lib/dashboard/aggregate';
import { formatDuration } from '@/lib/time';
import { sparklinePath } from './sparkline';

const cellStyle = (i: number): CSSProperties => ({
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  gap: 10,
  minHeight: 168,
  padding: '18px 20px',
  borderRight: i < 3 ? '1px solid var(--nx-line-inner)' : undefined,
});

const labelStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  fontSize: 11,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-3)',
};

const valueStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 44,
  lineHeight: 1,
  fontWeight: 700,
  letterSpacing: '-0.03em',
  color: 'var(--nx-ink)',
  fontVariantNumeric: 'tabular-nums',
};

const footerStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11.5,
  color: 'var(--nx-ink-3)',
};

function DeltaBadge({ delta, goodWhenUp }: { delta: KpiDelta; goodWhenUp: boolean }) {
  if (!delta.deltaAvailable || delta.deltaValue === null) return null;
  const up = delta.deltaValue >= 0;
  const good = up === goodWhenUp;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 7px',
        background: 'var(--nx-raised)',
        fontFamily: 'var(--nx-font-mono)',
        fontSize: 11.5,
        color: good ? 'var(--nx-success)' : 'var(--nx-danger-text)',
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
      <path d={path.area} fill="var(--nx-blue-panel)" fillOpacity={0.08} stroke="none" />
      <path
        className="nx-spark-draw"
        pathLength={1}
        d={path.line}
        fill="none"
        stroke="var(--nx-blue-panel)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
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
        background: 'var(--nx-surface)',
        border: '1px solid var(--nx-line)',
        borderRadius: 'var(--nx-radius)',
      }}
    >
      <div style={cellStyle(0)}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={labelStyle}>Runs</span>
          <DeltaBadge delta={aggregate.kpis.runs} goodWhenUp />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
          <span style={valueStyle}>{aggregate.kpis.runs.value.toLocaleString()}</span>
          <Spark values={runsSpark} />
        </div>
        <span style={footerStyle}>{windowLabel}</span>
      </div>

      <div style={cellStyle(1)}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={labelStyle}>Success rate</span>
          <DeltaBadge delta={aggregate.kpis.successRatePct} goodWhenUp />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
          <span style={valueStyle}>{aggregate.kpis.runs.value === 0 ? '\u2014' : `${successRatePct}%`}</span>
          <Spark values={rateSpark} />
        </div>
        <span style={footerStyle}>
          {aggregate.kpis.runs.value === 0 ? 'No runs loaded yet' : `${aggregate.days.reduce((s, d) => s + d.failed, 0)} failed runs`}
        </span>
      </div>

      <div style={cellStyle(2)}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={labelStyle}>Rows moved</span>
          <DeltaBadge delta={aggregate.kpis.rowsMoved} goodWhenUp />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
          <span style={valueStyle}>{aggregate.kpis.rowsMoved.value.toLocaleString()}</span>
          <Spark values={rowsSpark} />
        </div>
        <span style={footerStyle}>{windowLabel}</span>
      </div>

      <div style={cellStyle(3)}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={labelStyle}>Median run time</span>
          <DeltaBadge delta={aggregate.kpis.medianDurationMs} goodWhenUp={false} />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
          <span style={valueStyle}>{formatDuration(aggregate.kpis.medianDurationMs.value || null)}</span>
        </div>
        <span style={footerStyle}>
          {aggregate.p95DurationMs.value !== null
            ? `Slowest 5%: ${formatDuration(aggregate.p95DurationMs.value)}`
            : 'Not enough runs yet for p95'}
        </span>
      </div>
    </section>
  );
}
