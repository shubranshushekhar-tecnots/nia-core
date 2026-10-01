import type { CSSProperties } from 'react';

/**
 * Console v2 Slice 5 — the token usage page's own styles file (task spec:
 * "own styles file", distinct from the shared ./styles.ts every other
 * Console screen pulls from). General-purpose primitives (stat cards,
 * buttons, inputs, content wrapper, pills) are still reused from
 * ./styles.ts — only usage-page-specific layout (filter bar, chart cards,
 * breakdown tables, top-consumers lists) lives here.
 */

export const consoleUsageFilterBarStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-end',
  gap: 12,
  padding: '14px 16px',
  borderRadius: 12,
  background: 'var(--nx-surface)',
  border: '1px solid var(--nx-line)',
};

export const consoleUsageFilterFieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

export const consoleUsageFilterLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-3)',
};

export const consoleUsageFilterInputStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: 170,
  height: 32,
  padding: '0 10px',
  fontFamily: 'inherit',
  fontSize: 12.5,
  color: 'var(--nx-ink)',
  background: 'var(--nx-raised)',
  border: '1px solid var(--nx-line)',
  borderRadius: 8,
  outline: 'none',
};

export const consoleUsageFilterActionsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginLeft: 'auto',
};

export const consoleUsageFilterErrorStyle: CSSProperties = {
  flex: '1 1 100%',
  fontSize: 12.5,
  color: 'var(--nx-danger-text)',
};

// Chart cards (TokensChart/CostChart in ConsoleUsageCharts.tsx) — same
// surface/radius/border language as consoleStatCardStyle in ./styles.ts,
// sized for a chart instead of a single number.
export const consoleUsageChartCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '16px 18px',
  borderRadius: 12,
  background: 'var(--nx-surface)',
  border: '1px solid var(--nx-line)',
};

export const consoleUsageChartHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
};

export const consoleUsageChartTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-display)',
  fontSize: 14,
  fontWeight: 700,
  color: 'var(--nx-ink)',
};

export const consoleUsageChartSubStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--nx-ink-3)',
};

export const consoleUsageChartLegendStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
};

export const consoleUsageChartLegendItemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
  letterSpacing: '.04em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-2)',
};

export function consoleUsageChartLegendSwatchStyle(color: string): CSSProperties {
  return { width: 10, height: 2, background: color, display: 'inline-block' };
}

export const consoleUsageChartEmptyStyle: CSSProperties = {
  height: 150,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 12.5,
  color: 'var(--nx-ink-3)',
};

export const consoleUsageChartTooltipStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  width: 140,
  padding: '8px 10px',
  background: 'var(--nx-ink)',
  color: 'var(--nx-bg)',
  borderRadius: 10,
  fontFamily: 'var(--font-data)',
  fontSize: 12,
  lineHeight: '18px',
  pointerEvents: 'none',
};

// Breakdown tables (by model / by feature) and top-consumers lists — a
// simpler, generic flex-row table than ./styles.ts's directory-table column
// set (consoleColAccountStyle etc.), since usage rows have a different,
// fixed shape (label + 4 numeric columns) shared by both tables.
export const consoleUsageSectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

export const consoleUsageSectionsRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 16,
};

export const consoleUsageTableWrapStyle: CSSProperties = {
  borderRadius: 12,
  background: 'var(--nx-surface)',
  border: '1px solid var(--nx-line)',
  padding: '4px 16px',
};

export const consoleUsageTableHeadRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '9px 0',
  borderBottom: '1px solid var(--nx-line)',
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-3)',
};

export const consoleUsageRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 0',
  borderBottom: '1px solid var(--nx-line)',
};

export const consoleUsageColLabelStyle: CSSProperties = {
  flex: '2 1 120px',
  minWidth: 90,
  fontSize: 12.5,
  color: 'var(--nx-ink)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const consoleUsageColNumberStyle: CSSProperties = {
  flex: '1 1 70px',
  minWidth: 60,
  textAlign: 'right',
  fontFamily: 'var(--font-data)',
  fontSize: 11.5,
  color: 'var(--nx-ink-2)',
};

export const consoleUsageColCostStyle: CSSProperties = {
  flex: '1 1 80px',
  minWidth: 70,
  textAlign: 'right',
  fontFamily: 'var(--font-data)',
  fontSize: 12,
  fontWeight: 700,
  color: 'var(--nx-ink)',
};
