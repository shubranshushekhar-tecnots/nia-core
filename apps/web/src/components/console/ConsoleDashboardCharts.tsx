'use client';

import { useState } from 'react';
import type { ConsoleRunsPerDayPoint } from '@/lib/api/consoleServer';
import { buildPoints, formatCompactNumber, lineSegments } from '@/components/app/home/chartMath';
import {
  consoleDashboardChartCardStyle,
  consoleDashboardChartEmptyStyle,
  consoleDashboardChartHeaderStyle,
  consoleDashboardChartLegendItemStyle,
  consoleDashboardChartLegendStyle,
  consoleDashboardChartLegendSwatchStyle,
  consoleDashboardChartSubStyle,
  consoleDashboardChartTitleStyle,
  consoleDashboardChartTooltipStyle,
} from './dashboardStyles';

/**
 * Console v2 Slice 6 — hand-rolled SVG chart for the dashboard home's
 * "runs per day" view, same viewBox/gridlines/hover-tooltip pattern as
 * ConsoleUsageCharts.tsx (Slice 5) and the Home dashboard's TrendCharts.tsx,
 * reusing the same generic chartMath.ts helpers. Three lines (succeeded /
 * failed / running) rather than two, since the task spec calls out
 * "runs per day (ok/failed)" explicitly and running is the natural third
 * state already carried by the data.
 */

const VB_W = 420;
const X0 = 36;
const PLOT_W = 354;
const Y0 = 10;
const PLOT_H = 130;

function dayLabel(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00`);
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
}

function Gridlines({ ticks }: { ticks: number[] }) {
  return (
    <>
      {ticks.map((t, i) => {
        const y = Y0 + PLOT_H - (PLOT_H * t) / (ticks[0] || 1);
        return (
          <g key={t}>
            <line x1={X0} x2={X0 + PLOT_W} y1={y} y2={y} stroke="var(--line)" strokeOpacity={i === ticks.length - 1 ? 1 : 0.5} />
            <text x={X0 - 8} y={y + 4} textAnchor="end" fontSize={11} fontFamily="var(--font-data)" fill="var(--ink3)">
              {t === 0 ? '0' : formatCompactNumber(Math.round(t))}
            </text>
          </g>
        );
      })}
    </>
  );
}

export function RunsPerDayChart({ points }: { points: ConsoleRunsPerDayPoint[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (points.length === 0) {
    return (
      <section style={consoleDashboardChartCardStyle}>
        <div style={consoleDashboardChartHeaderStyle}>
          <div>
            <h3 style={consoleDashboardChartTitleStyle}>Runs per day</h3>
            <span style={consoleDashboardChartSubStyle}>Succeeded, failed, running</span>
          </div>
        </div>
        <div style={consoleDashboardChartEmptyStyle}>No runs in this range</div>
      </section>
    );
  }

  const succeededValues = points.map((p) => p.succeeded);
  const failedValues = points.map((p) => p.failed);
  const runningValues = points.map((p) => p.running);
  const max = Math.max(1, ...succeededValues, ...failedValues, ...runningValues) * 1.2;
  const ticks = [max, max / 2, 0];

  const succeededPoints = buildPoints(succeededValues, X0, PLOT_W, Y0, PLOT_H, max);
  const failedPoints = buildPoints(failedValues, X0, PLOT_W, Y0, PLOT_H, max);
  const runningPoints = buildPoints(runningValues, X0, PLOT_W, Y0, PLOT_H, max);
  const succeededLines = lineSegments(succeededPoints);
  const failedLines = lineSegments(failedPoints);
  const runningLines = lineSegments(runningPoints);
  const slot = PLOT_W / Math.max(1, points.length - 1);
  const hover = hoverIdx !== null ? points[hoverIdx] : null;
  const hoverPoint = hoverIdx !== null ? succeededPoints[hoverIdx] : null;

  return (
    <section style={consoleDashboardChartCardStyle}>
      <div style={consoleDashboardChartHeaderStyle}>
        <div>
          <h3 style={consoleDashboardChartTitleStyle}>Runs per day</h3>
          <span style={consoleDashboardChartSubStyle}>Last {points.length} days</span>
        </div>
        <div style={consoleDashboardChartLegendStyle}>
          <span style={consoleDashboardChartLegendItemStyle}>
            <span style={consoleDashboardChartLegendSwatchStyle('var(--success-deep)')} />
            Succeeded
          </span>
          <span style={consoleDashboardChartLegendItemStyle}>
            <span style={consoleDashboardChartLegendSwatchStyle('var(--error-deep)')} />
            Failed
          </span>
          <span style={consoleDashboardChartLegendItemStyle}>
            <span style={consoleDashboardChartLegendSwatchStyle('var(--ink3)')} />
            Running
          </span>
        </div>
      </div>
      <div style={{ position: 'relative', height: 172 }} onMouseLeave={() => setHoverIdx(null)}>
        <svg width="100%" height={150} viewBox={`0 0 ${VB_W} 150`} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
          <Gridlines ticks={ticks} />
          {succeededLines.map((d, i) => (
            <path key={`ok-${i}`} d={d} fill="none" stroke="var(--success-deep)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {failedLines.map((d, i) => (
            <path key={`bad-${i}`} d={d} fill="none" stroke="var(--error-deep)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {runningLines.map((d, i) => (
            <path key={`run-${i}`} d={d} fill="none" stroke="var(--ink3)" strokeWidth={2} strokeDasharray="3 3" strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {hover && hoverPoint && (
            <line x1={hoverPoint.x} x2={hoverPoint.x} y1={Y0} y2={Y0 + PLOT_H} stroke="var(--ink3)" strokeDasharray="2 3" />
          )}
          <text x={X0} y={164} fontSize={11} fontFamily="var(--font-data)" fill="var(--ink3)">
            {dayLabel(points[0]?.date ?? '')}
          </text>
          <text x={X0 + PLOT_W} y={164} textAnchor="end" fontSize={11} fontFamily="var(--font-data)" fill="var(--ink3)">
            {dayLabel(points[points.length - 1]?.date ?? '')}
          </text>
        </svg>
        {points.map((p, i) => (
          <div
            key={p.date}
            onMouseEnter={() => setHoverIdx(i)}
            style={{ position: 'absolute', top: 0, height: 150, left: X0 + slot * i - slot / 2, width: slot }}
          />
        ))}
        {hover && hoverPoint && (
          <div style={{ ...consoleDashboardChartTooltipStyle, left: Math.min(hoverPoint.x + 12, VB_W - 150) }}>
            <div style={{ opacity: 0.7 }}>{dayLabel(hover.date)}</div>
            <div>Succeeded: {hover.succeeded.toLocaleString()}</div>
            <div>Failed: {hover.failed.toLocaleString()}</div>
            <div>Running: {hover.running.toLocaleString()}</div>
          </div>
        )}
      </div>
    </section>
  );
}

export function RowsPerDayChart({ points }: { points: ConsoleRunsPerDayPoint[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (points.length === 0) {
    return (
      <section style={consoleDashboardChartCardStyle}>
        <div style={consoleDashboardChartHeaderStyle}>
          <div>
            <h3 style={consoleDashboardChartTitleStyle}>Rows moved per day</h3>
            <span style={consoleDashboardChartSubStyle}>No runs in this range</span>
          </div>
        </div>
        <div style={consoleDashboardChartEmptyStyle}>No runs in this range</div>
      </section>
    );
  }

  const values = points.map((p) => p.rowsProcessed);
  const total = values.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...values) * 1.2;
  const ticks = [max, max / 2, 0];

  const chartPoints = buildPoints(values, X0, PLOT_W, Y0, PLOT_H, max);
  const lines = lineSegments(chartPoints);
  const slot = PLOT_W / Math.max(1, points.length - 1);
  const hover = hoverIdx !== null ? points[hoverIdx] : null;
  const hoverPoint = hoverIdx !== null ? chartPoints[hoverIdx] : null;

  return (
    <section style={consoleDashboardChartCardStyle}>
      <div style={consoleDashboardChartHeaderStyle}>
        <div>
          <h3 style={consoleDashboardChartTitleStyle}>Rows moved per day</h3>
          <span style={consoleDashboardChartSubStyle}>{formatCompactNumber(total)} rows in range</span>
        </div>
      </div>
      <div style={{ position: 'relative', height: 172 }} onMouseLeave={() => setHoverIdx(null)}>
        <svg width="100%" height={150} viewBox={`0 0 ${VB_W} 150`} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
          <Gridlines ticks={ticks} />
          {lines.map((d, i) => (
            <path key={i} d={d} fill="none" stroke="var(--primary)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {hover && hoverPoint && (
            <>
              <line x1={hoverPoint.x} x2={hoverPoint.x} y1={Y0} y2={Y0 + PLOT_H} stroke="var(--ink3)" strokeDasharray="2 3" />
              <circle cx={hoverPoint.x} cy={hoverPoint.y} r={4.5} fill="var(--primary)" stroke="var(--surface)" strokeWidth={2} />
            </>
          )}
          <text x={X0} y={164} fontSize={11} fontFamily="var(--font-data)" fill="var(--ink3)">
            {dayLabel(points[0]?.date ?? '')}
          </text>
          <text x={X0 + PLOT_W} y={164} textAnchor="end" fontSize={11} fontFamily="var(--font-data)" fill="var(--ink3)">
            {dayLabel(points[points.length - 1]?.date ?? '')}
          </text>
        </svg>
        {points.map((p, i) => (
          <div
            key={p.date}
            onMouseEnter={() => setHoverIdx(i)}
            style={{ position: 'absolute', top: 0, height: 150, left: X0 + slot * i - slot / 2, width: slot }}
          />
        ))}
        {hover && hoverPoint && (
          <div style={{ ...consoleDashboardChartTooltipStyle, left: Math.min(hoverPoint.x + 12, VB_W - 150) }}>
            <div style={{ opacity: 0.7 }}>{dayLabel(hover.date)}</div>
            <div>{hover.rowsProcessed.toLocaleString()} rows</div>
          </div>
        )}
      </div>
    </section>
  );
}

export default function ConsoleDashboardCharts({ runsPerDay }: { runsPerDay: ConsoleRunsPerDayPoint[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
      <RunsPerDayChart points={runsPerDay} />
      <RowsPerDayChart points={runsPerDay} />
    </div>
  );
}
