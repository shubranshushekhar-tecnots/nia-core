'use client';

import { useState } from 'react';
import type { ConsoleUsageTimeseriesPoint } from '@/lib/api/consoleServer';
import { areaSegments, buildPoints, formatCompactNumber, lastLoadedPoint, lineSegments } from '@/components/app/home/chartMath';
import {
  consoleUsageChartCardStyle,
  consoleUsageChartEmptyStyle,
  consoleUsageChartHeaderStyle,
  consoleUsageChartLegendItemStyle,
  consoleUsageChartLegendStyle,
  consoleUsageChartLegendSwatchStyle,
  consoleUsageChartSubStyle,
  consoleUsageChartTitleStyle,
  consoleUsageChartTooltipStyle,
} from './usageStyles';

/**
 * Console v2 Slice 5 — hand-rolled SVG charts for the token usage page,
 * following the same viewBox/gridlines/hover-tooltip pattern as the Home
 * dashboard's TrendCharts.tsx (apps/web/src/components/app/home/
 * TrendCharts.tsx), reusing its generic chartMath.ts helpers, but using
 * Console's own theme tokens (--primary/--success-deep/--ink* etc., see
 * ./styles.ts) instead of the app shell's --nx-* tokens, and its own doc
 * data shape (ConsoleUsageTimeseriesPoint) instead of DashboardAggregate.
 *
 * Unlike TrendCharts, every point here already has real data — the
 * timeseries endpoint only ever returns days where usage occurred, there's
 * no "day not loaded yet" concept — so chartMath's null-gap handling is
 * exercised but never actually triggered in practice.
 */

const VB_W = 420;
const X0 = 36;
const PLOT_W = 354;
const Y0 = 10;
const PLOT_H = 130;

const usdFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const usdFormatterCompact = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});

/**
 * USD currency formatter for cost values across the usage page. No shared
 * currency formatter exists elsewhere in the codebase (checked lib/time.ts
 * and the broader lib/ tree) — defined here, next to the chart that needs
 * it most, and reused by ConsoleUsageClient.tsx's stat cards/tables.
 */
export function formatUsd(n: number): string {
  return usdFormatter.format(n);
}

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
            <line x1={X0} x2={X0 + PLOT_W} y1={y} y2={y} stroke="var(--c-line)" strokeOpacity={i === ticks.length - 1 ? 1 : 0.5} />
            <text x={X0 - 8} y={y + 4} textAnchor="end" fontSize={11} fontFamily="var(--c-font-mono)" fill="var(--c-text-3)">
              {formatTick(t)}
            </text>
          </g>
        );
      })}
    </>
  );
}

function TokensChart({ points }: { points: ConsoleUsageTimeseriesPoint[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (points.length === 0) {
    return (
      <section style={consoleUsageChartCardStyle}>
        <div style={consoleUsageChartHeaderStyle}>
          <div>
            <h3 style={consoleUsageChartTitleStyle}>Tokens per day</h3>
            <span style={consoleUsageChartSubStyle}>Input vs output</span>
          </div>
        </div>
        <div style={consoleUsageChartEmptyStyle}>No usage in this range</div>
      </section>
    );
  }

  const inputValues = points.map((p) => p.inputTokens);
  const outputValues = points.map((p) => p.outputTokens);
  const max = Math.max(1, ...inputValues, ...outputValues) * 1.2;
  const ticks = [max, max / 2, 0];

  const inputPoints = buildPoints(inputValues, X0, PLOT_W, Y0, PLOT_H, max);
  const outputPoints = buildPoints(outputValues, X0, PLOT_W, Y0, PLOT_H, max);
  const inputLines = lineSegments(inputPoints);
  const outputLines = lineSegments(outputPoints);
  const slot = PLOT_W / Math.max(1, points.length - 1);
  const hover = hoverIdx !== null ? points[hoverIdx] : null;
  const hoverPoint = hoverIdx !== null ? inputPoints[hoverIdx] : null;

  return (
    <section style={consoleUsageChartCardStyle}>
      <div style={consoleUsageChartHeaderStyle}>
        <div>
          <h3 style={consoleUsageChartTitleStyle}>Tokens per day</h3>
          <span style={consoleUsageChartSubStyle}>Input vs output</span>
        </div>
        <div style={consoleUsageChartLegendStyle}>
          <span style={consoleUsageChartLegendItemStyle}>
            <span style={consoleUsageChartLegendSwatchStyle('var(--c-accent-text)')} />
            Input
          </span>
          <span style={consoleUsageChartLegendItemStyle}>
            <span style={consoleUsageChartLegendSwatchStyle('#60A5FA')} />
            Output
          </span>
        </div>
      </div>
      <div style={{ position: 'relative', height: 172 }} onMouseLeave={() => setHoverIdx(null)}>
        <svg width="100%" height={150} viewBox={`0 0 ${VB_W} 150`} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
          <Gridlines ticks={ticks} formatTick={(v) => (v === 0 ? '0' : formatCompactNumber(Math.round(v)))} />
          {inputLines.map((d, i) => (
            <path key={`in-${i}`} d={d} fill="none" stroke="var(--c-accent-text)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {outputLines.map((d, i) => (
            <path
              key={`out-${i}`}
              d={d}
              fill="none"
              stroke="#60A5FA"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {hover && hoverPoint && (
            <line x1={hoverPoint.x} x2={hoverPoint.x} y1={Y0} y2={Y0 + PLOT_H} stroke="var(--c-text-3)" strokeDasharray="2 3" />
          )}
          <text x={X0} y={164} fontSize={11} fontFamily="var(--c-font-mono)" fill="var(--c-text-3)">
            {dayLabel(points[0]?.date ?? '')}
          </text>
          <text x={X0 + PLOT_W} y={164} textAnchor="end" fontSize={11} fontFamily="var(--c-font-mono)" fill="var(--c-text-3)">
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
          <div style={{ ...consoleUsageChartTooltipStyle, left: Math.min(hoverPoint.x + 12, VB_W - 150) }}>
            <div style={{ opacity: 0.7 }}>{dayLabel(hover.date)}</div>
            <div>Input: {hover.inputTokens.toLocaleString()}</div>
            <div>Output: {hover.outputTokens.toLocaleString()}</div>
          </div>
        )}
      </div>
    </section>
  );
}

function CostChart({ points }: { points: ConsoleUsageTimeseriesPoint[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (points.length === 0) {
    return (
      <section style={consoleUsageChartCardStyle}>
        <div style={consoleUsageChartHeaderStyle}>
          <div>
            <h3 style={consoleUsageChartTitleStyle}>Cost per day</h3>
            <span style={consoleUsageChartSubStyle}>No usage in this range</span>
          </div>
        </div>
        <div style={consoleUsageChartEmptyStyle}>No usage in this range</div>
      </section>
    );
  }

  const values = points.map((p) => p.cost);
  const total = values.reduce((a, b) => a + b, 0);
  const max = Math.max(0.01, ...values) * 1.2;
  const ticks = [max, max / 2, 0];

  const chartPoints = buildPoints(values, X0, PLOT_W, Y0, PLOT_H, max);
  const lines = lineSegments(chartPoints);
  const areas = areaSegments(chartPoints, Y0 + PLOT_H);
  const slot = PLOT_W / Math.max(1, points.length - 1);
  const hover = hoverIdx !== null ? points[hoverIdx] : null;
  const hoverPoint = hoverIdx !== null ? chartPoints[hoverIdx] : null;
  const endPoint = lastLoadedPoint(chartPoints);
  const lastValue = values[values.length - 1] ?? 0;

  return (
    <section style={consoleUsageChartCardStyle}>
      <div style={consoleUsageChartHeaderStyle}>
        <div>
          <h3 style={consoleUsageChartTitleStyle}>Cost per day</h3>
          <span style={consoleUsageChartSubStyle}>{formatUsd(total)} total in range</span>
        </div>
      </div>
      <div style={{ position: 'relative', height: 172 }} onMouseLeave={() => setHoverIdx(null)}>
        <svg width="100%" height={150} viewBox={`0 0 ${VB_W} 150`} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
          <Gridlines ticks={ticks} formatTick={(v) => (v === 0 ? '$0' : usdFormatterCompact.format(v))} />
          {areas.map((d, i) => (
            <path key={i} d={d} fill="var(--c-accent-text)" fillOpacity={0.1} />
          ))}
          {lines.map((d, i) => (
            <path key={i} d={d} fill="none" stroke="var(--c-accent-text)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {endPoint && (
            <text x={X0 + PLOT_W - 12} y={endPoint.y - 8} textAnchor="end" fontSize={11.5} fontWeight={600} fill="var(--c-text)">
              {formatUsd(lastValue)}
            </text>
          )}
          {hover && hoverPoint && (
            <>
              <line x1={hoverPoint.x} x2={hoverPoint.x} y1={Y0} y2={Y0 + PLOT_H} stroke="var(--c-text-3)" strokeDasharray="2 3" />
              <circle cx={hoverPoint.x} cy={hoverPoint.y} r={4.5} fill="var(--c-accent-text)" stroke="var(--c-surface)" strokeWidth={2} />
            </>
          )}
          <text x={X0} y={164} fontSize={11} fontFamily="var(--c-font-mono)" fill="var(--c-text-3)">
            {dayLabel(points[0]?.date ?? '')}
          </text>
          <text x={X0 + PLOT_W} y={164} textAnchor="end" fontSize={11} fontFamily="var(--c-font-mono)" fill="var(--c-text-3)">
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
          <div style={{ ...consoleUsageChartTooltipStyle, left: Math.min(hoverPoint.x + 12, VB_W - 150) }}>
            <div style={{ opacity: 0.7 }}>{dayLabel(hover.date)}</div>
            <div>{formatUsd(hover.cost)}</div>
          </div>
        )}
      </div>
    </section>
  );
}

export default function ConsoleUsageCharts({ timeseries }: { timeseries: ConsoleUsageTimeseriesPoint[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
      <TokensChart points={timeseries} />
      <CostChart points={timeseries} />
    </div>
  );
}
