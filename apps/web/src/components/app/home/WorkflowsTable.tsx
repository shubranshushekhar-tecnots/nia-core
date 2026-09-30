import type { WorkflowRow } from '@/lib/dashboard/homeViewModel';
import { formatDuration, relativeTime } from '@/lib/time';

const GRID_COLS = '2.2fr 1.3fr 1.6fr 0.9fr 0.8fr 1fr';

// Status vocabulary (Precision Dark redesign, Step 3): succeeded is a quiet
// grey glyph, failed is a loud red X, running pulses the blue-panel accent
// — matches Activity/NeedsAttention and the chart legends.
const STATUS_STYLE: Record<WorkflowRow['status'], { color: string; glyph: string; pulsing?: boolean }> = {
  ok: { color: 'var(--nx-success)', glyph: '\u25a0' },
  fail: { color: 'var(--nx-danger-text)', glyph: '\u2715' },
  running: { color: 'var(--nx-blue-panel)', glyph: '\u25a0', pulsing: true },
};

const sectionTitleStyle = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 800,
  fontSize: 22,
  letterSpacing: '0.01em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink)',
} as const;

const headerCellStyle = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  fontSize: 12,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-3)',
} as const;

export default function WorkflowsTable({ rows }: { rows: WorkflowRow[] }) {
  return (
    <section
      aria-label="Workflows"
      style={{ background: 'var(--nx-surface)', border: '1px solid var(--nx-line)', borderRadius: 'var(--nx-radius)', display: 'flex', flexDirection: 'column' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px 12px 24px' }}>
        <h2 style={{ margin: 0, ...sectionTitleStyle }}>Workflows</h2>
      </div>
      <div
        role="row"
        style={{
          display: 'grid',
          gridTemplateColumns: GRID_COLS,
          gap: 16,
          padding: '8px 24px',
          borderTop: '1px solid var(--nx-line)',
          borderBottom: '1px solid var(--nx-line)',
        }}
      >
        <span style={headerCellStyle}>Workflow</span>
        <span style={headerCellStyle}>Status</span>
        <span style={headerCellStyle}>Last runs</span>
        <span style={{ ...headerCellStyle, textAlign: 'right' }}>Rows</span>
        <span style={{ ...headerCellStyle, textAlign: 'right' }}>Median</span>
        <span style={headerCellStyle}>Last run</span>
      </div>
      {rows.length === 0 ? (
        <div className="nx-halftone" style={{ padding: '32px 24px', fontSize: 13, color: 'var(--nx-ink-2)' }}>
          No workflow runs loaded yet.
        </div>
      ) : (
        rows.map((row) => {
          const status = STATUS_STYLE[row.status];
          return (
            <div
              key={row.workflowId}
              role="row"
              className="nx-wipe"
              style={{
                display: 'grid',
                gridTemplateColumns: GRID_COLS,
                gap: 16,
                alignItems: 'center',
                height: 56,
                padding: '0 24px',
                borderBottom: '1px solid var(--nx-line-inner)',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span style={{ fontFamily: 'var(--nx-font-ui)', fontSize: 15, fontWeight: 500, color: 'var(--nx-ink)' }}>
                  {row.workflowName}
                </span>
              </div>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--nx-font-mono)', fontSize: 12.5, fontWeight: 500, color: status.color }}>
                <span style={{ fontSize: 10, animation: status.pulsing ? 'livePulse 1.4s ease-in-out infinite' : undefined }}>
                  {status.glyph}
                </span>
                {row.statusLabel}
              </span>
              <div aria-label={row.stripLabel} style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 20 }}>
                {row.strip.map((s, i) => (
                  <span
                    key={i}
                    style={{
                      display: 'block',
                      width: 5,
                      height: s.succeeded ? 12 : 20,
                      background: s.succeeded ? 'var(--nx-success)' : 'var(--nx-danger)',
                    }}
                  />
                ))}
              </div>
              <span style={{ textAlign: 'right', fontFamily: 'var(--nx-font-mono)', fontVariantNumeric: 'tabular-nums', fontSize: 13, color: 'var(--nx-ink)' }}>
                {row.rowsProcessed.toLocaleString()}
              </span>
              <span style={{ textAlign: 'right', fontFamily: 'var(--nx-font-mono)', fontVariantNumeric: 'tabular-nums', fontSize: 13, color: 'var(--nx-ink)' }}>
                {formatDuration(row.medianDurationMs)}
              </span>
              <span style={{ fontSize: 12.5, color: 'var(--nx-ink-2)' }}>{relativeTime(row.lastRunAt)}</span>
            </div>
          );
        })
      )}
    </section>
  );
}
