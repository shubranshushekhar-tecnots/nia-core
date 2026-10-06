import type { CSSProperties } from 'react';

/**
 * Shared chrome for every public, logged-out page outside /app — currently
 * /downloads and /docs/agent/*. Mirrors AuthShell's header (logo cell +
 * wordmark + theme toggle, apps/web/src/components/auth/nxStyles.ts) so a
 * visitor sees one consistent shell across sign-in, downloads and docs,
 * plus nav links to the other public sections and a footer.
 */

export const nxPublicRootStyle: CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--nx-bg)',
  color: 'var(--nx-ink)',
  fontFamily: 'var(--nx-font-ui)',
};

export const nxPublicHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  minHeight: 64,
  borderBottom: '1px solid var(--nx-line)',
  flex: 'none',
};

export const nxPublicLogoCellStyle: CSSProperties = {
  width: 64,
  height: 64,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRight: '1px solid var(--nx-line)',
};

export const nxPublicWordmarkStyle: CSSProperties = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 800,
  fontSize: 22,
  letterSpacing: '0.02em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink)',
  textDecoration: 'none',
  padding: '0 16px',
};

export const nxPublicNavCellStyle: CSSProperties = {
  flex: 1,
  padding: '0 24px',
  minWidth: 0,
};

export function nxPublicNavLinkStyle(active: boolean): CSSProperties {
  return {
    fontFamily: 'var(--nx-font-condensed)',
    fontStretch: '62.5%',
    fontWeight: 700,
    fontSize: 13,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    textDecoration: 'none',
    color: active ? 'var(--nx-ink)' : 'var(--nx-ink-2)',
  };
}

export const nxPublicThemeToggleStyle: CSSProperties = {
  width: 64,
  height: 64,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  border: 'none',
  borderLeft: '1px solid var(--nx-line)',
  color: 'var(--nx-ink-2)',
  cursor: 'pointer',
};

export const nxPublicMainStyle: CSSProperties = {
  flex: 1,
};

export const nxPublicFooterStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
  gap: 12,
  padding: '20px 40px',
  borderTop: '1px solid var(--nx-line)',
  fontSize: 13,
  color: 'var(--nx-ink-3)',
};

export const nxPublicFooterLinksStyle: CSSProperties = {
  display: 'flex',
  gap: 20,
  flexWrap: 'wrap',
};

export const nxPublicFooterLinkStyle: CSSProperties = {
  color: 'var(--nx-ink-2)',
  textDecoration: 'none',
};
