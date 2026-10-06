import type { CSSProperties } from 'react';

/**
 * Public "Download Nia Core Agent" page. Dedicated file per the project's
 * convention (see components/agents/styles.ts's header comment for the
 * precedent) — never add these to components/app/styles.ts.
 */

export const nxDownloadsPageStyle: CSSProperties = {
  minHeight: '100vh',
  background: 'var(--nx-bg)',
  color: 'var(--nx-ink)',
};

export const nxDownloadsHeaderStyle: CSSProperties = {
  padding: '56px 40px 32px',
  borderBottom: '1px solid var(--nx-line)',
  maxWidth: 920,
};

export const nxDownloadsEyebrowStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  letterSpacing: '0.04em',
  fontSize: 14,
  textTransform: 'uppercase',
  color: 'var(--nx-ink-2)',
};

export const nxDownloadsH1Style: CSSProperties = {
  margin: '10px 0 14px',
  fontFamily: 'var(--font-inter-tight), var(--nx-font-ui)',
  fontSize: 56,
  lineHeight: '58px',
  fontWeight: 500,
  letterSpacing: '-0.03em',
};

export const nxDownloadsSubtitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 16,
  lineHeight: '24px',
  color: 'var(--nx-ink-2)',
  maxWidth: 640,
};

export const nxDownloadsNoticeStyle: CSSProperties = {
  marginTop: 20,
  padding: '14px 16px',
  border: '1px solid var(--nx-warn)',
  color: 'var(--nx-warn)',
  fontSize: 13,
  lineHeight: '20px',
  maxWidth: 640,
};

export const nxDownloadsVersionRowStyle: CSSProperties = {
  marginTop: 18,
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12,
  letterSpacing: '0.04em',
  color: 'var(--nx-ink-3)',
};

export const nxDownloadsCardsGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
  maxWidth: 1080,
};

export function nxDownloadsCardStyle(highlight: boolean): CSSProperties {
  return {
    padding: '28px 28px 24px',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    borderRight: '1px solid var(--nx-line)',
    borderBottom: '1px solid var(--nx-line)',
    background: highlight ? 'var(--nx-raised)' : 'transparent',
  };
}

export const nxDownloadsCardTopRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

export const nxDownloadsOsNameStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-inter-tight), var(--nx-font-ui)',
  fontSize: 22,
  fontWeight: 500,
  letterSpacing: '-0.01em',
};

export const nxDownloadsBadgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 20,
  padding: '0 8px',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 10,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--nx-blue-panel-text)',
  background: 'var(--nx-blue-panel)',
};

export const nxDownloadsYourSystemStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 20,
  padding: '0 8px',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 10,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--nx-success)',
  border: '1px solid var(--nx-line)',
};

export const nxDownloadsReqTextStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: '19px',
  color: 'var(--nx-ink-2)',
};

export const nxDownloadsMetaRowStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  color: 'var(--nx-ink-3)',
};

export const nxDownloadsChecksumStyle: CSSProperties = {
  overflowWrap: 'anywhere',
  wordBreak: 'break-all',
};

export function nxDownloadsPrimaryBtnStyle(): CSSProperties {
  return {
    marginTop: 'auto',
    height: 42,
    padding: '0 16px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid var(--nx-ink)',
    background: 'var(--nx-ink)',
    color: 'var(--nx-bg)',
    fontFamily: 'var(--nx-font-mono)',
    fontSize: 12,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    textDecoration: 'none',
    cursor: 'pointer',
  };
}

export const nxDownloadsAdvancedLinkStyle: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--nx-ink-3)',
  textDecoration: 'underline',
};

export const nxDownloadsSectionStyle: CSSProperties = {
  padding: '32px 40px',
  borderBottom: '1px solid var(--nx-line)',
  maxWidth: 920,
};

export const nxDownloadsSectionTitleStyle: CSSProperties = {
  margin: '0 0 12px',
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  letterSpacing: '0.04em',
  fontSize: 15,
  textTransform: 'uppercase',
  color: 'var(--nx-ink-2)',
};

export const nxDownloadsBodyTextStyle: CSSProperties = {
  margin: '0 0 10px',
  fontSize: 14,
  lineHeight: '22px',
  color: 'var(--nx-ink-2)',
};

export const nxDownloadsCodeChipStyle: CSSProperties = {
  display: 'inline-block',
  padding: '2px 6px',
  border: '1px solid var(--nx-line)',
  background: 'var(--nx-surface)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 12.5,
  color: 'var(--nx-ink)',
};

export const nxDownloadsGuidesListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

export const nxDownloadsGuideLinkStyle: CSSProperties = {
  fontSize: 14,
  color: 'var(--nx-ink)',
};
