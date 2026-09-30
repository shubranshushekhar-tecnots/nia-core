import type { RecentRun } from '@/lib/dashboard/types';
import { formatDuration } from '@/lib/time';

const BAR_AREA_H = 130;

const sectionTitleStyle = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 800,
  fontSize: 22,
  letterSpacing: '0.01em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink)',
} as const;

/**
 * Used instead of the 14-day trend charts while there isn't enough history
 * for a daily trend to mean anything (see HomeContent's threshold). Shows
 * each of the loaded runs as its own bar — genuinely all the data there is,
 * no gaps to explain away.
 */
export default function RunsSoFarChart({ runs }: { runs: RecentRun[] }) {
  const sorted = [...runs].sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
  const succeededCount = sorted.filter((r) => r.status === 'succeeded').length;
  const durations = sorted.map((r) => r.durationMs).filter((d): d is number => d !== null);
  const maxMs = Math.max(1000, ...durations) * 1.2;
  const ticks = [maxMs, maxMs / 2, 0];

  return (
    <section
      aria-label="Run time, each run so far"
      style={{
        background: 'var(--nx-surface)',
        border: '1px solid var(--nx-line)',
        borderRadius: 'var(--nx-radius)',
        padding: '20px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <h2 style={{ margin: 0, ...sectionTitleStyle }}>Run time, each run so far</h2>
        <span style={{ fontSize: 13, color: 'var(--nx-ink-2)' }}>
          {sorted.length} run{sorted.length === 1 ? '' : 's'} loaded, {succeededCount} succeeded
        </span>
      </div>
      <div style={{ position: 'relative', height: 170 }}>
        {ticks.map((t) => {
          const y = 10 + BAR_AREA_H - (BAR_AREA_H * t) / (maxMs || 1);
          return (
            <div
              key={t}
              style={{ position: 'absolute', left: 36, right: 0, top: y, borderTop: `1px solid ${t === 0 ? 'var(--nx-line)' : 'var(--nx-line-inner)'}` }}
            >
              <span
                style={{
                  position: 'absolute',
                  left: -36,
                  top: -8,
                  width: 28,
                  textAlign: 'right',
                  fontFamily: 'var(--nx-font-mono)',
                  fontSize: 11,
                  color: 'var(--nx-ink-3)',
                }}
              >
                {formatDuration(Math.round(t))}
              </span>
            </div>
          );
        })}
        <div
          style={{
            position: 'absolute',
            left: 56,
            right: 20,
            top: 10,
            height: BAR_AREA_H,
            display: 'grid',
            gridTemplateColumns: `repeat(${Math.max(1, sorted.length)}, minmax(0, 1fr))`,
            gap: 16,
            alignItems: 'end',
          }}
        >
          {sorted.map((run, i) => {
            const h = run.durationMs === null ? 0 : (BAR_AREA_H * run.durationMs) / maxMs;
            const color =
              run.status === 'failed' ? 'var(--nx-danger)' : run.status === 'running' ? 'var(--nx-blue-panel)' : 'var(--nx-success)';
            return (
              <div
                key={run.id}
                tabIndex={0}
                aria-label={`Run ${i + 1}: ${run.status}, ${formatDuration(run.durationMs)}`}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: BAR_AREA_H, position: 'relative' }}
              >
                {run.durationMs !== null && (
                  <span
                    style={{
                      fontFamily: 'var(--nx-font-mono)',
                      fontSize: 11.5,
                      fontWeight: 500,
                      marginBottom: 4,
                      color: 'var(--nx-ink-2)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {formatDuration(run.durationMs)}
                  </span>
                )}
                <div
                  className="nx-bar-grow"
                  style={{
                    width: '100%',
                    maxWidth: 28,
                    height: Math.max(2, h),
                    background: color,
                    animation: run.status === 'running' ? 'livePulse 1.4s ease-in-out infinite' : undefined,
                  }}
                />
                <span style={{ position: 'absolute', bottom: -22, fontFamily: 'var(--nx-font-mono)', fontSize: 11, color: 'var(--nx-ink-3)' }}>
                  {i + 1}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
