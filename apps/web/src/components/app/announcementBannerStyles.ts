import type { CSSProperties } from 'react';

/**
 * Subscription Phase 5, Slice 4 (docs/plans/subscription-model.md, decision
 * 1). AnnouncementBanner's own styles file — deliberately separate from
 * components/app/styles.ts (off-limits, another session's concurrent UI
 * work) per this session's "new UI gets its own styles file" rule. Same
 * tone-map approach as components/console/styles.ts's
 * consoleAnnouncementPreviewStyle, reusing the same theme.css tokens
 * (--ink/--subtle/--line/--warning-deep/--error-deep) already in scope
 * under AppShell's own data-app-theme/data-om-theme="light" root.
 */
export const announcementBannerStackStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '12px 24px 0',
};

export function announcementBannerRowStyle(severity: 'info' | 'warning' | 'critical'): CSSProperties {
  const map: Record<'info' | 'warning' | 'critical', [string, string, string]> = {
    info: ['var(--ink)', 'var(--subtle)', 'var(--line)'],
    warning: ['var(--warning-deep)', 'rgba(245,158,11,.1)', 'rgba(245,158,11,.4)'],
    critical: ['var(--error-deep)', 'rgba(239,68,68,.1)', 'rgba(239,68,68,.4)'],
  };
  const [color, background, border] = map[severity];
  return {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    padding: '10px 14px',
    borderRadius: 10,
    color,
    background,
    border: `1px solid ${border}`,
  };
}

export const announcementBannerTextStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

export const announcementBannerTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
};

export const announcementBannerBodyStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.4,
  whiteSpace: 'pre-wrap',
};

export const announcementBannerDismissStyle: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 15,
  lineHeight: 1,
  padding: 2,
  opacity: 0.6,
};
