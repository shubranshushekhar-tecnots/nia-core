'use client';

import type { PreviewValue } from '@nia/schemas';

/**
 * Renders a destination-node read preview (Block 1, Phase 5 Session 5).
 * Table-only by default; the single "trivially derivable" auto-chart case
 * (one numeric column + a text label column) renders as a plain CSS bar
 * list — no chart library exists in this codebase yet (checked
 * apps/web/package.json), and pulling one in for exactly one bar-chart case
 * is out of scope this session. Full AI-suggested charting is ledgered for
 * a later phase (see TODO.md), not built here.
 *
 * `residualCount > 0` means the compiled preview did NOT execute every
 * in-stream transform on the path — shown as an explicit notice so this
 * never reads as more complete than it is (PreviewValue's header comment
 * in packages/schemas/src/previewResult.ts).
 */

const tableWrapStyle = {
  border: '1px solid var(--line2)',
  borderRadius: 8,
  overflow: 'hidden',
} as const;

const headerRowStyle = {
  display: 'flex',
  background: 'var(--surface2)',
  borderBottom: '1px solid var(--line2)',
} as const;

const rowStyle = {
  display: 'flex',
  borderBottom: '1px solid var(--line)',
} as const;

const cellStyle = {
  flex: '1 0 0',
  minWidth: 90,
  padding: '6px 8px',
  fontFamily: 'var(--font-data)',
  fontSize: 12,
  color: 'var(--ink)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
} as const;

const headerCellStyle = {
  ...cellStyle,
  fontWeight: 600,
  color: 'var(--ink3)',
  fontSize: 11,
} as const;

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '\u2014';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function AutoChart({ preview }: { preview: PreviewValue }) {
  if (!preview.chart) return null;
  const { labelColumn, valueColumn } = preview.chart;
  const labelIdx = preview.columns.findIndex((c) => c.name === labelColumn);
  const valueIdx = preview.columns.findIndex((c) => c.name === valueColumn);
  if (labelIdx === -1 || valueIdx === -1) return null;
  const bars = preview.rows.map((r) => ({ label: formatCell(r[labelIdx]), value: Number(r[valueIdx]) || 0 }));
  const max = Math.max(1, ...bars.map((b) => b.value));
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink4)', marginBottom: 6 }}>
        {valueColumn} by {labelColumn}
      </div>
      {bars.map((b, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ width: 90, fontSize: 11.5, color: 'var(--ink3)', flex: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.label}</span>
          <div style={{ flex: 1, background: 'var(--surface2)', borderRadius: 3, height: 12 }}>
            <div style={{ width: `${(b.value / max) * 100}%`, background: 'var(--accent, #6366f1)', height: 12, borderRadius: 3 }} />
          </div>
          <span style={{ fontSize: 11, fontFamily: 'var(--font-data)', color: 'var(--ink4)', flex: 'none' }}>{b.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function PreviewTable({ preview }: { preview: PreviewValue }) {
  return (
    <div>
      <AutoChart preview={preview} />
      <div style={tableWrapStyle}>
        <div style={headerRowStyle}>
          {preview.columns.map((c) => (
            <div key={c.name} style={headerCellStyle}>
              {c.name}
            </div>
          ))}
        </div>
        {preview.rows.map((row, i) => (
          <div key={i} style={rowStyle}>
            {row.map((v, j) => (
              <div key={j} style={cellStyle}>
                {formatCell(v)}
              </div>
            ))}
          </div>
        ))}
        {preview.rows.length === 0 && (
          <div style={{ padding: '10px 8px', fontSize: 12, color: 'var(--ink4)' }}>No rows returned.</div>
        )}
      </div>
      {preview.truncated && (
        <div style={{ fontSize: 11, color: 'var(--ink4)', marginTop: 6 }}>Preview capped at 50 rows.</div>
      )}
      {preview.residualCount > 0 && (
        <div style={{ fontSize: 11, color: 'var(--warn)', marginTop: 6 }}>
          {preview.residualCount} in-stream transform{preview.residualCount === 1 ? '' : 's'} will apply at run time — not shown in this preview.
        </div>
      )}
    </div>
  );
}
