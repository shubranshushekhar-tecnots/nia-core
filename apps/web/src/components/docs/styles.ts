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
};

export const nxDocsHeaderStyle: CSSProperties = {
  padding: '48px 40px 28px',
  borderBottom: '1px solid var(--nx-line)',
  maxWidth: 760,
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

export const nxDocsNoticeStyle: CSSProperties = {
  padding: '12px 14px',
  border: '1px solid var(--nx-warn)',
  color: 'var(--nx-warn)',
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

// ---- Index page ("/docs/agent") ------------------------------------------

export const nxDocsIndexListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
};

export const nxDocsIndexRowStyle: CSSProperties = {
  display: 'block',
  padding: '18px 0',
  borderBottom: '1px solid var(--nx-line-inner)',
  textDecoration: 'none',
};

export const nxDocsIndexTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 17,
  fontWeight: 500,
  color: 'var(--nx-ink)',
};

export const nxDocsIndexDescStyle: CSSProperties = {
  margin: '4px 0 0',
  fontSize: 13.5,
  color: 'var(--nx-ink-3)',
};
