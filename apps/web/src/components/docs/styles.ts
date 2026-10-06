import type { CSSProperties } from 'react';

/**
 * Shared layout for every public /docs/agent/* page — one "prose" look
 * reused across all ten guides instead of a bespoke styles.ts per page.
 * Precision Dark tokens only (see components/agents/styles.ts precedent).
 */

export const nxDocsPageStyle: CSSProperties = {
  minHeight: '100vh',
  background: 'var(--nx-bg)',
  color: 'var(--nx-ink)',
  fontFamily: 'var(--nx-font-ui)',
};

export const nxDocsHeaderStyle: CSSProperties = {
  padding: '48px 40px 28px',
  borderBottom: '1px solid var(--nx-line)',
};

export const nxDocsBackLinkStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11.5,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-3)',
};

export const nxDocsEyebrowStyle: CSSProperties = {
  display: 'block',
  marginTop: 14,
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  letterSpacing: '0.04em',
  fontSize: 14,
  textTransform: 'uppercase',
  color: 'var(--nx-ink-2)',
};

export const nxDocsH1Style: CSSProperties = {
  margin: '8px 0 0',
  fontFamily: 'var(--font-inter-tight), var(--nx-font-ui)',
  fontSize: 44,
  lineHeight: '48px',
  fontWeight: 500,
  letterSpacing: '-0.02em',
};

export const nxDocsBodyStyle: CSSProperties = {
  maxWidth: 760,
  padding: '32px 40px 56px',
  display: 'flex',
  flexDirection: 'column',
  gap: 24,
};

export const nxDocsH2Style: CSSProperties = {
  margin: '0 0 4px',
  fontFamily: 'var(--font-inter-tight), var(--nx-font-ui)',
  fontSize: 22,
  fontWeight: 500,
  letterSpacing: '-0.01em',
};

export const nxDocsPStyle: CSSProperties = {
  margin: 0,
  fontSize: 15,
  lineHeight: '24px',
  color: 'var(--nx-ink-2)',
};

export const nxDocsListStyle: CSSProperties = {
  margin: 0,
  paddingLeft: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  fontSize: 15,
  lineHeight: '23px',
  color: 'var(--nx-ink-2)',
};

export const nxDocsCodeChipStyle: CSSProperties = {
  display: 'inline-block',
  padding: '2px 6px',
  border: '1px solid var(--nx-line)',
  background: 'var(--nx-surface)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 13,
  color: 'var(--nx-ink)',
};

// Names of buttons/controls referenced in prose (e.g. "click More info, then
// Run anyway") — a filled chip so it reads as a UI label, distinct from the
// monospace code chip above.
export const nxDocsButtonNameStyle: CSSProperties = {
  display: 'inline-block',
  padding: '2px 8px',
  border: '1px solid var(--nx-line)',
  background: 'var(--nx-raised)',
  fontFamily: 'var(--nx-font-ui)',
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--nx-ink)',
};

export const nxDocsCodeBlockStyle: CSSProperties = {
  margin: 0,
  padding: '12px 14px',
  border: '1px solid var(--nx-line)',
  background: 'var(--nx-surface)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 13,
  lineHeight: '20px',
  color: 'var(--nx-ink)',
  overflowX: 'auto',
  whiteSpace: 'pre-wrap',
};

export const nxDocsTableStyle: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 13.5,
};

export const nxDocsThStyle: CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px',
  borderBottom: '1px solid var(--nx-line)',
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  letterSpacing: '0.03em',
  fontSize: 12,
  textTransform: 'uppercase',
  color: 'var(--nx-ink-3)',
};

export const nxDocsTdStyle: CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px',
  borderBottom: '1px solid var(--nx-line-inner)',
  color: 'var(--nx-ink-2)',
  verticalAlign: 'top',
};

// A callout for both "note" and "warning" copy — a left accent bar + tint
// background reads as a proper callout box rather than just colored text.
// Every existing guide page already imports this for exactly that kind of
// aside, so the visual upgrade needed no call-site changes.
export const nxDocsNoticeStyle: CSSProperties = {
  padding: '12px 16px',
  borderLeft: '3px solid var(--nx-warn)',
  background: 'var(--nx-raised)',
  color: 'var(--nx-ink-2)',
  fontSize: 13.5,
  lineHeight: '20px',
};

export const nxDocsSeeAlsoStyle: CSSProperties = {
  marginTop: 8,
  paddingTop: 20,
  borderTop: '1px solid var(--nx-line)',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

export const nxDocsSeeAlsoLinkStyle: CSSProperties = {
  fontSize: 14,
  color: 'var(--nx-ink)',
};

// Wraps a <pre style={nxDocsCodeBlockStyle}> so a CopyButton can be
// absolutely positioned in its top-right corner.
export const nxDocsCodeBlockWrapStyle: CSSProperties = {
  position: 'relative',
};

export const nxDocsCodeCopyBtnStyle: CSSProperties = {
  position: 'absolute',
  top: 6,
  right: 6,
};

// ---- Sidebar (every guide page) ------------------------------------------

export const nxDocsLayoutStyle: CSSProperties = {
  maxWidth: 1040,
};

export const nxDocsSidebarDesktopStyle: CSSProperties = {
  padding: '32px 24px',
  borderRight: '1px solid var(--nx-line)',
  position: 'sticky',
  top: 0,
};

export const nxDocsSidebarMobileStyle: CSSProperties = {
  borderBottom: '1px solid var(--nx-line)',
  padding: '16px 40px',
};

export const nxDocsSidebarSummaryStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  letterSpacing: '0.04em',
  fontSize: 13,
  textTransform: 'uppercase',
  color: 'var(--nx-ink-2)',
  cursor: 'pointer',
};

export const nxDocsSidebarListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  marginTop: 12,
};

export function nxDocsSidebarLinkStyle(active: boolean): CSSProperties {
  return {
    padding: '7px 10px',
    fontSize: 13.5,
    lineHeight: '18px',
    textDecoration: 'none',
    borderLeft: `2px solid ${active ? 'var(--nx-ink)' : 'transparent'}`,
    background: active ? 'var(--nx-surface)' : 'transparent',
    color: active ? 'var(--nx-ink)' : 'var(--nx-ink-2)',
    fontWeight: active ? 500 : 400,
  };
}

// ---- Previous / next (bottom of every guide page) ------------------------

export const nxDocsPrevNextStyle: CSSProperties = {
  marginTop: 8,
  paddingTop: 20,
  borderTop: '1px solid var(--nx-line)',
  display: 'flex',
  justifyContent: 'space-between',
  gap: 16,
};

export function nxDocsPrevNextLinkStyle(align: 'left' | 'right'): CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    textAlign: align,
    textDecoration: 'none',
    maxWidth: '48%',
  };
}

export const nxDocsPrevNextLabelStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink-3)',
};

export const nxDocsPrevNextTitleStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 500,
  color: 'var(--nx-ink)',
};

// ---- Index page ("/docs/agent") ------------------------------------------

export const nxDocsIndexListStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
  gap: 16,
};

export const nxDocsIndexRowStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '18px 20px',
  border: '1px solid var(--nx-line)',
  background: 'var(--nx-surface)',
  textDecoration: 'none',
};

export const nxDocsIndexTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-inter-tight), var(--nx-font-ui)',
  fontSize: 17,
  fontWeight: 500,
  color: 'var(--nx-ink)',
};

export const nxDocsIndexDescStyle: CSSProperties = {
  margin: 0,
  fontSize: 13.5,
  lineHeight: '19px',
  color: 'var(--nx-ink-3)',
};
