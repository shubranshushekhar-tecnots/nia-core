import type { CSSProperties } from 'react';

/**
 * Console v2 Slice 6 — the dashboard home's own styles file (same "own
 * styles file" precedent as Slice 5's ./usageStyles.ts). General-purpose
 * primitives (stat cards, pills, content wrapper, section titles, empty
 * state) are still reused from ./styles.ts — only dashboard-specific
 * layout (two-up chart grid, needs-attention list rows) lives here.
 */

export const consoleDashboardChartsRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 16,
};

export const consoleDashboardChartCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '16px 18px',
  borderRadius: 12,
  background: 'var(--nx-surface)',
  border: '1px solid var(--nx-line)',
};

export const consoleDashboardChartHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
};

export const consoleDashboardChartTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-display)',
  fontSize: 14,
  fontWeight: 700,
  color: 'var(--nx-ink)',
};

export const consoleDashboardChartSubStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--nx-ink-3)',
};

export const consoleDashboardChartLegendStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
};

export const consoleDashboardChartLegendItemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
  letterSpacing: '.04em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-2)',
};

export function consoleDashboardChartLegendSwatchStyle(color: string): CSSProperties {
  return { width: 10, height: 2, background: color, display: 'inline-block' };
}

export const consoleDashboardChartEmptyStyle: CSSProperties = {
  height: 150,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 12.5,
  color: 'var(--nx-ink-3)',
};

export const consoleDashboardChartTooltipStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  width: 150,
  padding: '8px 10px',
  background: 'var(--nx-ink)',
  color: 'var(--nx-bg)',
  borderRadius: 10,
  fontFamily: 'var(--font-data)',
  fontSize: 12,
  lineHeight: '18px',
  pointerEvents: 'none',
};

// Needs-attention list — a simple card list (not a table, since each row
// has a different "detail" shape per reason) using the same card border
// language as consoleStatCardStyle.
export const consoleDashboardAttentionListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

export const consoleDashboardAttentionRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '12px 16px',
  borderRadius: 12,
  background: 'var(--nx-surface)',
  border: '1px solid var(--nx-line)',
};

export const consoleDashboardAttentionOrgColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
};

export const consoleDashboardAttentionOrgNameStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: 'var(--nx-ink)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const consoleDashboardAttentionDetailStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--nx-ink-3)',
};

export const consoleDashboardSectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};
