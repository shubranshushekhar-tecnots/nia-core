'use client';

import { useState } from 'react';
import type { DashboardAggregate } from '@/lib/dashboard/aggregate';
import type { DurationPoint } from '@/lib/dashboard/homeViewModel';
import { formatDuration } from '@/lib/time';
import { areaSegments, buildPoints, formatCompactNumber, lastLoadedPoint, lineSegments } from './chartMath';

const VB_W = 420;
const X0 = 36;
const PLOT_W = 354;
const Y0 = 10;
const PLOT_H = 130;

const sectionTitleStyle = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 800,
  fontSize: 22,
  letterSpacing: '0.01em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink)',
} as const;

const subtitleStyle = { fontSize: 13, color: 'var(--nx-ink-2)' } as const;

const cardStyle = {
  background: 'var(--nx-surface)',
  border: '1px solid var(--nx-line)',
  borderRadius: 'var(--nx-radius)',
  padding: '20px 24px 16px',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
} as const;

function dayLabel(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00`);
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
}

function Gridlines({ ticks, formatTick }: { ticks: number[]; formatTick: (v: number) => string }) {
  return (
    <>
      {ticks.map((t, i) => {
        const y = Y0 + PLOT_H - (PLOT_H * t) / (ticks[0] || 1);
        return (
          <g key={t}>
            <line
              x1={X0}
              x2={X0 + PLOT_W}
              y1={y}
              y2={y}
              stroke={i === ticks.length - 1 ? 'var(--nx-line)' : 'var(--nx-line-inner)'}
            />
            <text x={X0 - 8} y={y + 4} textAnchor="end" fontSize={11} fontFamily="var(--nx-font-mono)" fill="var(--nx-ink-3)">
              {formatTick(t)}
            </text>
          </g>
        );
      })}
    </>
  );
}

function RowsMovedChart({ aggregate }: { aggregate: DashboardAggregate }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const { days } = aggregate;
  const values = days.map((d) => (d.loaded ? d.rowsProcessed : null));
  const loadedValues = values.filter((v): v is number => v !== null);
  const total = loadedValues.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...loadedValues) * 1.2;
  const ticks = [max, max / 2, 0];

  const points = buildPoints(values, X0, PLOT_W, Y0, PLOT_H, max);
  const lines = lineSegments(points);
  const areas = areaSegments(points, Y0 + PLOT_H);
  const slot = PLOT_W / Math.max(1, days.length - 1);
  const hoverDay = hoverIdx !== null ? days[hoverIdx] : undefined;
  const hoverPoint = hoverIdx !== null ? points[hoverIdx] : undefined;
  const hover = hoverDay && hoverPoint ? { day: hoverDay, point: hoverPoint } : null;

  return (
    <section aria-label="Rows moved" className={loadedValues.length === 0 ? 'nx-halftone' : undefined} style={cardStyle}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <h2 style={{ margin: 0, ...sectionTitleStyle }}>Rows moved</h2>
        <span style={subtitleStyle}>
          {loadedValues.length === 0 ? 'No runs loaded yet' : `${formatCompactNumber(total)} rows across all workflows`}
        </span>
      </div>
      <div style={{ position: 'relative', height: 172 }} onMouseLeave={() => setHoverIdx(null)}>
        <svg width="100%" height={150} viewBox={`0 0 ${VB_W} 150`} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
          <Gridlines ticks={ticks} formatTick={(v) => (v === 0 ? '0' : formatCompactNumber(Math.round(v)))} />
          {areas.map((d, i) => (
            <path key={i} d={d} fill="var(--nx-blue-panel)" fillOpacity={0.1} />
          ))}
          {lines.map((d, i) => (
            <path key={i} d={d} fill="none" stroke="var(--nx-blue-panel)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {hover && hover.day.loaded && (
            <>
              <line x1={hover.point.x} x2={hover.point.x} y1={Y0} y2={Y0 + PLOT_H} stroke="var(--nx-ink-3)" strokeDasharray="2 3" />
              <circle cx={hover.point.x} cy={hover.point.y} r={4.5} fill="var(--nx-blue-panel)" stroke="var(--nx-surface)" strokeWidth={2} />
            </>
          )}
          <text x={X0} y={164} fontSize={11} fontFamily="var(--nx-font-mono)" fill="var(--nx-ink-3)">
            {dayLabel(days[0]?.date ?? '')}
          </text>
          <text x={X0 + PLOT_W} y={164} textAnchor="end" fontSize={11} fontFamily="var(--nx-font-mono)" fill="var(--nx-ink-3)">
            {dayLabel(days[days.length - 1]?.date ?? '')}
          </text>
        </svg>
        {days.map((day, i) => (
          <div
            key={day.date}
            onMouseEnter={() => setHoverIdx(i)}
            onFocus={() => setHoverIdx(i)}
            tabIndex={day.loaded ? 0 : -1}
            style={{ position: 'absolute', top: 0, height: 150, left: X0 + slot * i - slot / 2, width: slot, outline: 'none' }}
          />
        ))}
        {hover && hover.day.loaded && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: Math.min(hover.point.x + 12, VB_W - 130),
              width: 120,
              padding: '8px 10px',
              background: 'var(--nx-ink)',
              color: 'var(--nx-bg)',
              borderRadius: 'var(--nx-radius)',
              fontFamily: 'var(--nx-font-mono)',
              fontSize: 12,
              lineHeight: '19px',
              pointerEvents: 'none',
            }}
          >
            <div style={{ opacity: 0.7 }}>{dayLabel(hover.day.date)}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 10, height: 2, background: 'var(--nx-blue-panel)' }} />
              <span style={{ fontWeight: 700 }}>{hover.day.rowsProcessed.toLocaleString()}</span>
              <span style={{ opacity: 0.7 }}>rows</span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function RunDurationChart({ aggregate, durationSeries }: { aggregate: DashboardAggregate; durationSeries: DurationPoint[] }) {
  const values = durationSeries.map((p) => (p.hasData ? p.medianMs : null));
  const loadedValues = values.filter((v): v is number => v !== null);
  const maxSeconds = Math.max(1, ...loadedValues.map((v) => v / 1000)) * 1.3;
  const ticks = [maxSeconds, maxSeconds / 2, 0];

  const points = buildPoints(
    values.map((v) => (v === null ? null : v / 1000)),
    X0,
    PLOT_W,
    Y0,
    PLOT_H,
    maxSeconds,
  );
  const lines = lineSegments(points);
  const endPoint = lastLoadedPoint(points);
  const endValueMs = (() => {
    for (let i = values.length - 1; i >= 0; i--) {
      const v = values[i];
      if (v !== undefined && v !== null) return v;
    }
    return null;
  })();
  const { p95DurationMs } = aggregate;
  const p95Label =
    p95DurationMs.value === null ? 'not enough runs yet' : `${formatDuration(p95DurationMs.value)} (last 14 days)`;

  return (
    <section aria-label="Run duration" className={loadedValues.length === 0 ? 'nx-halftone' : undefined} style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <h2 style={{ margin: 0, ...sectionTitleStyle }}>Run duration</h2>
          <span style={subtitleStyle}>Median per day \u00b7 slowest 5%: {p95Label}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--nx-ink-2)' }}>
          <span style={{ width: 14, height: 2, background: 'var(--nx-blue-panel)' }} />
          Median
        </div>
      </div>
      <div style={{ position: 'relative', height: 172 }}>
        <svg width="100%" height={170} viewBox={`0 0 ${VB_W} 170`} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
          <Gridlines ticks={ticks} formatTick={(v) => `${Math.round(v)}s`} />
          {lines.map((d, i) => (
            <path key={i} d={d} fill="none" stroke="var(--nx-blue-panel)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {endPoint && endValueMs !== null && (
            <text x={X0 + PLOT_W - 12} y={endPoint.y + 4} textAnchor="end" fontSize={11.5} fontWeight={700} fill="var(--nx-ink)">
              {formatDuration(endValueMs)}
            </text>
          )}
          <text x={X0} y={164} fontSize={11} fontFamily="var(--nx-font-mono)" fill="var(--nx-ink-3)">
            {dayLabel(durationSeries[0]?.date ?? '')}
          </text>
          <text x={X0 + PLOT_W} y={164} textAnchor="end" fontSize={11} fontFamily="var(--nx-font-mono)" fill="var(--nx-ink-3)">
            {dayLabel(durationSeries[durationSeries.length - 1]?.date ?? '')}
          </text>
        </svg>
        {loadedValues.length === 0 && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 12.5,
              color: 'var(--nx-ink-3)',
            }}
          >
            No runs loaded yet
          </div>
        )}
      </div>
    </section>
  );
}

export default function TrendCharts({ aggregate, durationSeries }: { aggregate: DashboardAggregate; durationSeries: DurationPoint[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
      <RowsMovedChart aggregate={aggregate} />
      <RunDurationChart aggregate={aggregate} durationSeries={durationSeries} />
    </div>
  );
}
