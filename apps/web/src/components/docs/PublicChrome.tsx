'use client';

import { useTheme } from 'next-themes';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Logo from '@/components/Logo';
import {
  nxPublicFooterLinkStyle,
  nxPublicFooterLinksStyle,
  nxPublicFooterStyle,
  nxPublicHeaderStyle,
  nxPublicLogoCellStyle,
  nxPublicNavCellStyle,
  nxPublicNavLinkStyle,
  nxPublicThemeToggleStyle,
  nxPublicWordmarkStyle,
} from './publicChromeStyles';

// Shared header/footer for every public, logged-out page outside /app:
// /downloads and /docs/agent/*. Same chrome as AuthShell (logo cell +
// wordmark + theme toggle) plus nav links between the two public sections,
// so a visitor sees one consistent shell from sign-in through to the docs.
export function PublicHeader() {
  const { resolvedTheme, setTheme } = useTheme();
  const pathname = usePathname();
  const isDark = resolvedTheme !== 'light';

  return (
    <header style={nxPublicHeaderStyle}>
      <Link href="/" style={nxPublicLogoCellStyle} className="nx-wipe">
        <Logo size={28} showWordmark={false} />
      </Link>
      <Link href="/" style={nxPublicWordmarkStyle}>
        Nia Core
      </Link>
      <nav className="nx-public-nav" style={nxPublicNavCellStyle}>
        <Link href="/downloads" style={nxPublicNavLinkStyle(pathname?.startsWith('/downloads') ?? false)}>
          Download agent
        </Link>
        <Link href="/docs/agent" style={nxPublicNavLinkStyle(pathname?.startsWith('/docs/agent') ?? false)}>
          Docs
        </Link>
      </nav>
      <button
        type="button"
        className="nx-wipe"
        onClick={() => setTheme(isDark ? 'light' : 'dark')}
        aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
        style={nxPublicThemeToggleStyle}
      >
        {isDark ? (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" aria-hidden>
            <circle cx="8" cy="8" r="3.5" />
            <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M3.3 12.7l1.4-1.4M11.3 4.7l1.4-1.4" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" aria-hidden>
            <path d="M13.5 9.5A6 6 0 0 1 6.5 2.5 6 6 0 1 0 13.5 9.5Z" />
          </svg>
        )}
      </button>
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer style={nxPublicFooterStyle}>
      <span>&copy; {new Date().getFullYear()} Nia Core</span>
      <div style={nxPublicFooterLinksStyle}>
        <Link href="/downloads" style={nxPublicFooterLinkStyle}>
          Download agent
        </Link>
        <Link href="/docs/agent" style={nxPublicFooterLinkStyle}>
          Documentation
        </Link>
        <Link href="/docs/agent/security" style={nxPublicFooterLinkStyle}>
          Security
        </Link>
        <Link href="/login" style={nxPublicFooterLinkStyle}>
          Sign in
        </Link>
      </div>
    </footer>
  );
}
