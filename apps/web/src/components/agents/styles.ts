import type { CSSProperties } from 'react';

/**
 * Slice L3 (docs/plans/agent-canvas-integration.md) — Agents page.
 * Dedicated file per the project's convention (never add to
 * components/app/styles.ts — see components/members/styles.ts's header
 * comment for the precedent). Generic nxModal* dialog primitives from
 * components/app/styles.ts are reused for AddAgentDialog/revoke confirm.
 */

// ---- Header / hero -------------------------------------------------------

// Precision Dark redesign parity pass: Members-style 220px two-column header
// (left: eyebrow/H1/subtitle, right: 2x2 "at a glance" stats grid) instead of
// the old single flex row — see members/styles.ts:15-97 for the precedent
// this mirrors exactly.
export const nxAgentsHeaderRowStyle: CSSProperties = {
  flexShrink: 0,
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)',
  minHeight: 220,
  borderBottom: '1px solid var(--nx-line)',
};

export const nxAgentsHeaderLeftColStyle: CSSProperties = {
  padding: '28px 40px',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  borderRight: '1px solid var(--nx-line)',
};

export const nxAgentsTitleColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

export const nxAgentsEyebrowStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  letterSpacing: '0.04em',
  fontSize: 16,
  textTransform: 'uppercase',
  color: 'var(--nx-ink-2)',
};

export const nxAgentsH1Style: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-inter-tight), var(--nx-font-ui)',
  fontSize: 88,
  lineHeight: '80px',
  fontWeight: 500,
  letterSpacing: '-0.05em',
};

export const nxAgentsSubtitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 16,
  color: 'var(--nx-ink-2)',
};

// Add-agent CTA now uses the shared .nx-wipe hover idiom (transparent/
// outlined at rest, ink fill only on hover) instead of being permanently
// filled — matches every other primary action in the app (e.g.
// AddAgentDialog's own submit button already does this).
export function nxAgentsAddBtnStyle(pending: boolean): CSSProperties {
  return {
    height: 40,
    padding: '0 18px',
    border: '1px solid var(--nx-line)',
    background: 'transparent',
    color: 'var(--nx-ink)',
    fontFamily: 'var(--nx-font-mono)',
    fontSize: 12,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    cursor: pending ? 'default' : 'pointer',
    opacity: pending ? 0.6 : 1,
  };
}

// ---- Stats grid (2x2, mirrors members/styles.ts:62-97) --------------------

export const nxAgentsStatsGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gridTemplateRows: 'repeat(2, minmax(0, 1fr))',
};

export function nxAgentsStatCellStyle(highlight: boolean): CSSProperties {
  return {
    padding: '16px 20px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    borderBottom: '1px solid var(--nx-line-inner)',
    borderRight: '1px solid var(--nx-line-inner)',
    background: highlight ? 'var(--nx-blue-panel)' : 'transparent',
    color: highlight ? 'var(--nx-blue-panel-text)' : 'var(--nx-ink)',
  };
}

export const nxAgentsStatLabelStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  letterSpacing: '0.04em',
  fontSize: 14,
  textTransform: 'uppercase',
  opacity: 0.8,
};

export const nxAgentsStatValueStyle: CSSProperties = {
  fontFamily: 'var(--font-inter-tight), var(--nx-font-ui)',
  fontSize: 40,
  lineHeight: '40px',
  fontWeight: 500,
  letterSpacing: '-0.04em',
};

// ---- List -----------------------------------------------------------------

const agentGridCols = '44px minmax(0, 1.1fr) 100px 140px 90px 130px 130px 110px 90px';

export const nxAgentsColumnHeaderRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: agentGridCols,
  gap: 14,
  height: 38,
  alignItems: 'center',
  padding: '0 24px',
  borderBottom: '1px solid var(--nx-line-inner)',
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  letterSpacing: '0.04em',
  fontSize: 13,
  color: 'var(--nx-ink-3)',
  textTransform: 'uppercase',
};

export const nxAgentsRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: agentGridCols,
  gap: 14,
  alignItems: 'center',
  minHeight: 60,
  padding: '0 24px',
  borderBottom: '1px solid var(--nx-line-inner)',
};

export const nxAgentsAvatarStyle: CSSProperties = {
  width: 36,
  height: 36,
  flexShrink: 0,
  background: 'var(--nx-raised)',
  color: 'var(--nx-ink)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 800,
  letterSpacing: '0.02em',
  fontSize: 16,
};

export const nxAgentsNameStyle: CSSProperties = {
  fontSize: 14,
  color: 'var(--nx-ink)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

// Fixed: --nx-success-text was never defined in theme.css, so this always
// silently fell back to a hardcoded bright green (#2e7d32) that matched
// nothing else in the palette. --nx-success is the real, already-themed
// token used everywhere else "ok" status renders (e.g. home/WorkflowsTable's
// quiet grey "succeeded" glyph).
export function nxAgentsStatusBadgeStyle(online: boolean): CSSProperties {
  return {
    // Every caller places this inside a grid row whose own `alignItems:
    // 'center'` centers plain-text cells vertically (nxAgentsRowStyle,
    // nxAgentsJobRowStyle, nxAgentsRunRowStyle) — `alignSelf: 'flex-start'`
    // here pinned just this cell to the row's top instead, visibly
    // misaligning the Online/Offline/Revoked badge against its row.
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    height: 24,
    padding: '0 8px',
    fontFamily: 'var(--nx-font-mono)',
    fontSize: 10.5,
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    color: online ? 'var(--nx-success)' : 'var(--nx-ink-3)',
  };
}

export function nxAgentsStatusDotStyle(online: boolean): CSSProperties {
  return {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: online ? 'var(--nx-success)' : 'var(--nx-ink-3)',
  };
}

export const nxAgentsMetaCellStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11.5,
  color: 'var(--nx-ink-3)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const nxAgentsRevokeBtnStyle: CSSProperties = {
  height: 32,
  border: '1px solid var(--nx-line)',
  background: 'transparent',
  color: 'var(--nx-danger-text)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  cursor: 'pointer',
};

// ---- Empty state ------------------------------------------------------

// Same halftone-texture + fade-up treatment as Home's "No runs yet" empty
// state (HomeContent.tsx) instead of a plain disconnected box.
export const nxAgentsEmptyPanelStyle: CSSProperties = {
  padding: '40px',
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
  maxWidth: 560,
  backgroundSize: '6px 6px',
};

export const nxAgentsEmptyStepStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 14,
};

export const nxAgentsEmptyStepNumStyle: CSSProperties = {
  flexShrink: 0,
  width: 24,
  height: 24,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--nx-raised)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  color: 'var(--nx-ink)',
};

export const nxAgentsEmptyTextStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  lineHeight: '20px',
  color: 'var(--nx-ink-2)',
};

// ---- Slice L4: local-job expand panel --------------------------------------

export const nxAgentsExpandToggleStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  color: 'var(--nx-ink-3)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 14,
};

export const nxAgentsExpandPanelStyle: CSSProperties = {
  gridColumn: '1 / -1',
  padding: '16px 24px 24px 84px',
  borderBottom: '1px solid var(--nx-line-inner)',
  background: 'var(--nx-raised)',
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
  transition: 'background 160ms var(--nx-ease)',
};

export const nxAgentsExpandSectionLabelStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  letterSpacing: '0.04em',
  fontSize: 12,
  textTransform: 'uppercase',
  color: 'var(--nx-ink-3)',
};

export const nxAgentsLocalTagStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 18,
  padding: '0 6px',
  marginLeft: 8,
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 9.5,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-3)',
  border: '1px solid var(--nx-line)',
};

const jobGridCols = 'minmax(0, 1fr) minmax(0, 1fr) 90px 100px 110px 120px 120px';

export const nxAgentsJobsHeaderRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: jobGridCols,
  gap: 12,
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  letterSpacing: '0.04em',
  fontSize: 11,
  textTransform: 'uppercase',
  color: 'var(--nx-ink-3)',
  padding: '0 0 6px 0',
};

export const nxAgentsJobRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: jobGridCols,
  gap: 12,
  alignItems: 'center',
  minHeight: 36,
};

const runGridCols = 'minmax(0, 1fr) 90px 90px 90px 70px 150px 150px';

export const nxAgentsRunsHeaderRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: runGridCols,
  gap: 12,
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  letterSpacing: '0.04em',
  fontSize: 11,
  textTransform: 'uppercase',
  color: 'var(--nx-ink-3)',
  padding: '0 0 6px 0',
};

export const nxAgentsRunRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: runGridCols,
  gap: 12,
  alignItems: 'center',
  minHeight: 32,
};

export const nxAgentsEmptyJobsTextStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: 'var(--nx-ink-3)',
};

// ---- Add-agent dialog: reveal-once command card ---------------------------

export const nxAgentsCreatedCardStyle: CSSProperties = {
  marginTop: 16,
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  border: '1px solid var(--nx-line)',
  background: 'var(--nx-raised)',
};

export const nxAgentsCreatedHeadingStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-2)',
};

export const nxAgentsCommandRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

export const nxAgentsCommandChipStyle: CSSProperties = {
  flexGrow: 1,
  minWidth: 0,
  padding: '10px 12px',
  border: '1px solid var(--nx-line)',
  background: 'var(--nx-surface)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  color: 'var(--nx-ink)',
  overflowX: 'auto',
  whiteSpace: 'pre',
};

export const nxAgentsCopyBtnStyle: CSSProperties = {
  flexShrink: 0,
  height: 36,
  padding: '0 12px',
  border: '1px solid var(--nx-line)',
  background: 'transparent',
  color: 'var(--nx-ink)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  cursor: 'pointer',
};

export const nxAgentsCopyFallbackStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--nx-ink-3)',
};

export const nxAgentsExpiryStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  color: 'var(--nx-ink-3)',
};

export const nxAgentsCreatedBodyStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: 'var(--nx-ink-2)',
};

// ---- Add-agent dialog: ordered setup steps --------------------------------

export const nxAgentsStepsListStyle: CSSProperties = {
  margin: '4px 0 0',
  paddingLeft: 18,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 12,
  color: 'var(--nx-ink-2)',
};
