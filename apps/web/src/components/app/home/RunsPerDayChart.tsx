'use client';

import { useState } from 'react';
import type { DailyBucket, DashboardAggregate } from '@/lib/dashboard/aggregate';

const PLOT_W = 876;
const PLOT_H = 200;
const BAR_W = 28;

const HATCH_STYLE = {
  backgroundImage:
    'repeating-linear-gradient(-45deg, var(--line-200) 0, var(--line-200) 3px, transparent 3px, transparent 7px)',
} as const;

function dayLabel(dateKey: string): { weekday: string; dom: string } {
  const d = new Date(`${dateKey}T00:00:00`);
  return {
    weekday: d.toLocaleDateString('en-US', { weekday: 'short' }),
    dom: d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' }),
  };
}

export default function RunsPerDayChart({ aggregate }: { aggregate: DashboardAggregate }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const { days } = aggregate;
  const max = Math.max(4, ...days.map((d) => d.succeeded + d.failed)) * 1.15;
  const slot = PLOT_W / days.length;
  const totalOk = days.reduce((s, d) => s + d.succeeded, 0);
  const totalFail = days.reduce((s, d) => s + d.failed, 0);
  const successPct = totalOk + totalFail === 0 ? null : Math.round((1000 * totalOk) / (totalOk + totalFail)) / 10;

  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  const hover = hoverIdx !== null ? days[hoverIdx] : null;

  return (
    <section
      aria-label="Runs per day"
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--line-100)',
        borderRadius: 12,
        padding: '20px 24px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <h2 style={{ margin: 0, fontSize: 15, lineHeight: '22px', fontWeight: 600 }}>Runs per day</h2>
          <span style={{ fontSize: 12.5, color: 'var(--ink-200)' }}>
            {successPct === null ? 'No runs loaded yet' : `${totalOk} succeeded, ${totalFail} failed \u00b7 ${successPct}% success`}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 12, color: 'var(--ink-200)' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--chart-ok)' }} />
            Succeeded
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--chart-fail)' }} />
            Failed
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, ...HATCH_STYLE }} />
            No data loaded
          </span>
        </div>
      </div>

      <div style={{ position: 'relative', height: PLOT_H + 28 }}>
        {ticks.map((t) => {
          const y = PLOT_H - (PLOT_H * t) / max;
          return (
            <div
              key={t}
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: y,
                height: 0,
                borderTop: `1px solid ${t === 0 ? 'var(--line-200)' : 'var(--line-100)'}`,
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  left: 0,
                  top: -9,
                  width: 24,
                  textAlign: 'right',
                  fontSize: 11,
                  color: 'var(--ink-300)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {t}
              </span>
            </div>
          );
        })}

        {days.map((day: DailyBucket, i: number) => {
          const left = 36 + slot * i + (slot - BAR_W) / 2;
          const on = hoverIdx === i;
          const { weekday, dom } = dayLabel(day.date);

          if (!day.loaded) {
            return (
              <div
                key={day.date}
                aria-label={`${weekday} ${dom}: no data loaded`}
                style={{
                  position: 'absolute',
                  left: left - (slot - BAR_W) / 2,
                  width: slot,
                  top: 0,
                  height: PLOT_H,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'flex-end',
                  alignItems: 'center',
                }}
              >
                <div style={{ width: BAR_W, height: 12, borderRadius: '4px 4px 0 0', ...HATCH_STYLE }} />
                <span style={{ position: 'absolute', bottom: -22, left: 0, right: 0, textAlign: 'center', fontSize: 11, color: 'var(--ink-300)' }}>
                  {dom}
                </span>
              </div>
            );
          }

          const hOk = (PLOT_H * day.succeeded) / max;
          const hFail = (PLOT_H * day.failed) / max;

          return (
            <div
              key={day.date}
              tabIndex={0}
              role="button"
              aria-label={`${weekday} ${dom}: ${day.succeeded} succeeded, ${day.failed} failed`}
              onMouseEnter={() => setHoverIdx(i)}
              onFocus={() => setHoverIdx(i)}
              style={{
                position: 'absolute',
                left: left - (slot - BAR_W) / 2,
                width: slot,
                top: 0,
                height: PLOT_H,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'flex-end',
                alignItems: 'center',
                gap: 2,
                outline: 'none',
                cursor: 'default',
                background: on ? 'rgba(89,76,223,0.05)' : undefined,
                borderRadius: on ? 6 : undefined,
              }}
            >
              {day.failed > 0 && (
                <div style={{ width: BAR_W, height: hFail, background: 'var(--chart-fail)', borderRadius: '4px 4px 0 0' }} />
              )}
              <div
                style={{
                  width: BAR_W,
                  height: hOk,
                  background: on ? 'var(--chart-ok-hover)' : 'var(--chart-ok)',
                  borderRadius: day.failed === 0 ? '4px 4px 0 0' : 0,
                }}
              />
              <span
                style={{
                  position: 'absolute',
                  bottom: -22,
                  left: 0,
                  right: 0,
                  textAlign: 'center',
                  fontSize: 11,
                  color: on ? 'var(--ink-100)' : 'var(--ink-300)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {dom}
              </span>
            </div>
          );
        })}

        {hover && hover.loaded && (
          <div
            style={{
              position: 'absolute',
              top: 20,
              left: Math.min(36 + slot * (hoverIdx ?? 0) + slot / 2 + 22, PLOT_W - 138),
              width: 150,
              padding: '10px 12px',
              background: 'var(--chart-tooltip-bg)',
              color: '#FFFFFF',
              borderRadius: 8,
              fontSize: 12.5,
              lineHeight: '20px',
              boxShadow: '0 8px 24px rgba(14,14,18,0.18)',
              pointerEvents: 'none',
            }}
          >
            <div style={{ fontSize: 12, color: '#B4B6BD', marginBottom: 4 }}>
              {dayLabel(hover.date).weekday}, {dayLabel(hover.date).dom}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 10, height: 2, background: 'var(--chart-tooltip-ok)' }} />
              <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', minWidth: 18 }}>{hover.succeeded}</span>
              <span style={{ color: '#B4B6BD' }}>succeeded</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 10, height: 2, background: 'var(--chart-tooltip-fail)' }} />
              <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', minWidth: 18 }}>{hover.failed}</span>
              <span style={{ color: '#B4B6BD' }}>failed</span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
