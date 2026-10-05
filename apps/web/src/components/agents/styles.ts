import type { CSSProperties } from 'react';

/**
 * Slice L3 (docs/plans/agent-canvas-integration.md) — Agents page.
 * Dedicated file per the project's convention (never add to
 * components/app/styles.ts — see components/members/styles.ts's header
 * comment for the precedent). Generic nxModal* dialog primitives from
 * components/app/styles.ts are reused for AddAgentDialog/revoke confirm.
 */

// ---- Header / hero -------------------------------------------------------

export const nxAgentsHeaderRowStyle: CSSProperties = {
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '28px 40px',
  borderBottom: '1px solid var(--nx-line)',
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
  fontSize: 56,
  lineHeight: '56px',
  fontWeight: 500,
  letterSpacing: '-0.05em',
};

export const nxAgentsSubtitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 16,
  color: 'var(--nx-ink-2)',
};

export function nxAgentsAddBtnStyle(pending: boolean): CSSProperties {
  return {
    height: 40,
    padding: '0 18px',
    border: '1px solid var(--nx-line)',
    background: 'var(--nx-ink)',
    color: 'var(--nx-bg)',
    fontFamily: 'var(--nx-font-mono)',
    fontSize: 12,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    cursor: pending ? 'default' : 'pointer',
    opacity: pending ? 0.6 : 1,
  };
}

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

export function nxAgentsStatusBadgeStyle(online: boolean): CSSProperties {
  return {
    alignSelf: 'flex-start',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    height: 24,
    padding: '0 8px',
    fontFamily: 'var(--nx-font-mono)',
    fontSize: 10.5,
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    color: online ? 'var(--nx-success-text, #2e7d32)' : 'var(--nx-ink-3)',
  };
}

export function nxAgentsStatusDotStyle(online: boolean): CSSProperties {
  return {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: online ? 'var(--nx-success-text, #2e7d32)' : 'var(--nx-ink-3)',
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

export const nxAgentsEmptyPanelStyle: CSSProperties = {
  padding: '40px',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  maxWidth: 560,
};

export const nxAgentsEmptyStepStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
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
