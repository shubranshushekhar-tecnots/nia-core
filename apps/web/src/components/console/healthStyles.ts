import type { CSSProperties } from 'react';

/**
 * Console redesign plan's Slice 4 — the System Health page's own styles
 * file (same "own styles file" precedent as dashboardStyles.ts/
 * usageStyles.ts). General-purpose primitives (stat cards, pills, content
 * wrapper, section titles) are reused from ./styles.ts — only the
 * queue-backlog list layout is specific enough to live here.
 */

export const consoleHealthQueueListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

export const consoleHealthQueueRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  padding: '12px 16px',
  borderRadius: 12,
  background: 'var(--nx-surface)',
  border: '1px solid var(--nx-line)',
};

export const consoleHealthQueueNameStyle: CSSProperties = {
  flex: '1 1 140px',
  fontSize: 13,
  fontWeight: 700,
  color: 'var(--nx-ink)',
};

export const consoleHealthQueueStatStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 70,
};

export const consoleHealthQueueStatLabelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: '.05em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-3)',
};

export const consoleHealthQueueStatValueStyle: CSSProperties = {
  fontFamily: 'var(--font-data)',
  fontSize: 14,
  fontWeight: 700,
  color: 'var(--nx-ink)',
};

export const consoleHealthMigrationRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  fontSize: 13,
  color: 'var(--nx-ink-2)',
};

export const consoleHealthSectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};
