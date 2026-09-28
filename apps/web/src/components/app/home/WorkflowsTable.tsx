import type { WorkflowRow } from '@/lib/dashboard/homeViewModel';
import { formatDuration, relativeTime } from '@/lib/time';

const GRID_COLS = '2.2fr 1.3fr 1.6fr 0.9fr 0.8fr 1fr';

const STATUS_STYLE: Record<WorkflowRow['status'], { color: string; dot: string }> = {
  ok: { color: 'var(--success)', dot: 'var(--chart-ok-hover)' },
  fail: { color: 'var(--danger)', dot: 'var(--chart-fail)' },
  running: { color: 'var(--ink-200)', dot: 'var(--ink-300)' },
};

export default function WorkflowsTable({ rows }: { rows: WorkflowRow[] }) {
  return (
    <section
      aria-label="Workflows"
      style={{ background: 'var(--surface)', border: '1px solid var(--line-100)', borderRadius: 12, display: 'flex', flexDirection: 'column' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px 12px 24px' }}>
        <h2 style={{ margin: 0, fontSize: 15, lineHeight: '22px', fontWeight: 600 }}>Workflows</h2>
      </div>
      <div
        role="row"
        style={{
          display: 'grid',
          gridTemplateColumns: GRID_COLS,
          gap: 16,
          padding: '8px 24px',
          borderTop: '1px solid var(--line-100)',
          borderBottom: '1px solid var(--line-100)',
          background: 'var(--surface-subtle)',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 10.5,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'var(--ink-300)',
        }}
      >
        <span>Workflow</span>
        <span>Status</span>
        <span>Last runs</span>
        <span style={{ textAlign: 'right' }}>Rows</span>
        <span style={{ textAlign: 'right' }}>Median</span>
        <span>Last run</span>
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: '32px 24px', fontSize: 13, color: 'var(--ink-200)' }}>No workflow runs loaded yet.</div>
      ) : (
        rows.map((row) => {
          const status = STATUS_STYLE[row.status];
          return (
            <div
              key={row.workflowId}
              role="row"
              style={{
                display: 'grid',
                gridTemplateColumns: GRID_COLS,
                gap: 16,
                alignItems: 'center',
                padding: '12px 24px',
                borderBottom: '1px solid var(--line-100)',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--ink-100)' }}>{row.workflowName}</span>
              </div>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 500, color: status.color }}>
                <span style={{ width: 7, height: 7, borderRadius: 4, background: status.dot }} />
                {row.statusLabel}
              </span>
              <div aria-label={row.stripLabel} style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 20 }}>
                {row.strip.map((s, i) => (
                  <span
                    key={i}
                    style={{
                      display: 'block',
                      width: 5,
                      borderRadius: 1.5,
                      height: s.succeeded ? 12 : 20,
                      background: s.succeeded ? 'var(--chart-strip-ok)' : 'var(--chart-fail)',
                    }}
                  />
                ))}
              </div>
              <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>
                {row.rowsProcessed.toLocaleString()}
              </span>
              <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>
                {formatDuration(row.medianDurationMs)}
              </span>
              <span style={{ fontSize: 12.5, color: 'var(--ink-200)' }}>{relativeTime(row.lastRunAt)}</span>
            </div>
          );
        })
      )}
    </section>
  );
}
