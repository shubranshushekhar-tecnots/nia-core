import type { CSSProperties } from 'react';

/**
 * Subscription Phase 5, Slice 4 (docs/plans/subscription-model.md, decision
 * 1). AnnouncementBanner's own styles file — deliberately separate from
 * components/app/styles.ts per this session's "new UI gets its own styles
 * file" rule. Precision Dark redesign (Step 8A item 4): matches Home's
 * plan-banner anatomy (planBannerStyle/planBannerPercentCellStyle/
 * planBannerBodyStyle/planBannerBtnStyle in components/app/styles.ts) — a
 * full-width row split into fixed meta / flex-grow message / fixed action
 * cells, each divided by a 1px border — but with a per-severity tint
 * background and a 5px accent left bar instead of plan-banner's single
 * solid-color treatment, since multiple announcements of different
 * severities can stack.
 */

type Severity = 'info' | 'warning' | 'critical';

function tone(severity: Severity): { bar: string; bg: string; ink: string } {
  switch (severity) {
    case 'info':
      return { bar: 'var(--nx-blue-panel)', bg: 'var(--nx-blue-tint)', ink: 'var(--nx-blue-soft-text)' };
    case 'warning':
      return { bar: 'var(--nx-warn)', bg: 'var(--nx-raised)', ink: 'var(--nx-warn)' };
    case 'critical':
      return { bar: 'var(--nx-danger)', bg: 'var(--nx-danger-tint)', ink: 'var(--nx-danger-text)' };
  }
}

export const announcementBannerStackStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
};

export function announcementBannerRowStyle(severity: Severity): CSSProperties {
  const t = tone(severity);
  return {
    display: 'flex',
    alignItems: 'stretch',
    minHeight: 52,
    borderBottom: '1px solid var(--nx-line)',
    borderLeftWidth: 5,
    borderLeftStyle: 'solid',
    borderLeftColor: t.bar,
    background: t.bg,
    color: t.ink,
    fontFamily: 'var(--nx-font-ui)',
  };
}

export const announcementBannerMetaCellStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  padding: '0 16px',
  borderRight: '1px solid var(--nx-line)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
};

export const announcementBannerTextStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  padding: '10px 16px',
};

export const announcementBannerBodyStyle: CSSProperties = {
  margin: 0,
  fontSize: 15,
  lineHeight: '20px',
  whiteSpace: 'pre-wrap',
};

export const announcementBannerDismissStyle: CSSProperties = {
  flex: 'none',
  width: 52,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: 'none',
  borderLeftWidth: 1,
  borderLeftStyle: 'solid',
  borderLeftColor: 'var(--nx-line)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 16,
  lineHeight: 1,
};
