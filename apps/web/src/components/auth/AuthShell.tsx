'use client';

import { useTheme } from 'next-themes';
import type { ReactNode } from 'react';
import Link from 'next/link';
import Logo from '@/components/Logo';
import {
  nxAuthFooterCellStyle,
  nxAuthFooterLinkTextStyle,
  nxAuthFormColStyle,
  nxAuthHeaderStyle,
  nxAuthHeadingStyle,
  nxAuthHeroStyle,
  nxAuthKickerStyle,
  nxAuthLogoCellStyle,
  nxAuthRootStyle,
  nxAuthSubtitleStyle,
  nxAuthThemeToggleStyle,
  nxAuthWordmarkStyle,
} from './nxStyles';

// Precision Dark redesign (Step 8B) — shared chrome for /login and /signup
// (+ the 2FA step), ported from designs/nia-design-source/Auth.dc.html +
// AuthStates.dc.html: a 64px header bar (logo cell + wordmark + theme
// toggle cell), then a two-column body — a halftone hero column carrying
// the heading/subtitle (moved out of the card, same strings/conditions),
// and a 560px form column with a full-width footer cell. `data-app-theme`
// on the root is what makes --nx-* resolve here (AuthStates.dc.html's own
// "THEME" note: "the root needs data-app-theme like the invite page").
//
// Theme toggle: previously a bespoke `nia-om-theme` localStorage flag
// scoped to [data-auth-theme] (the old light-indigo auth-only palette,
// now unused by this component). Rewired to next-themes' useTheme()/
// setTheme(), the same "nia-theme" storage key + html[data-nx-theme]
// mechanism that already drives the rest of the app (Sidebar's
// ThemeSwitcher) — AuthStates.dc.html itself flags this as the open
// question ("whether it should drive the app theme switcher"), and this
// is the answer: yes, for consistency there should be one theme, not two.
// The toggle here stays a simple binary (dark/light), matching the
// design's single button — not the app shell's 3-way dark/light/system
// segmented control.
export default function AuthShell({
  kicker,
  heading,
  subtitle,
  footerQuestion,
  footerLinkText,
  footerHref,
  children,
}: {
  kicker: string;
  heading: ReactNode;
  subtitle: ReactNode;
  footerQuestion?: string;
  footerLinkText?: string;
  footerHref?: string;
  children: ReactNode;
}) {
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme !== 'light';
  const hasFooter = Boolean(footerQuestion && footerLinkText && footerHref);

  return (
    <div data-app-theme="" data-om-theme="light" style={nxAuthRootStyle}>
      <div style={nxAuthHeaderStyle}>
        <div style={nxAuthLogoCellStyle}>
          <Logo size={28} showWordmark={false} />
        </div>
        <span style={nxAuthWordmarkStyle}>Nia Core</span>
        <button
          type="button"
          className="nx-wipe"
          onClick={() => setTheme(isDark ? 'light' : 'dark')}
          aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          style={nxAuthThemeToggleStyle}
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
      </div>

      <div className="nx-auth-body">
        <div className="nx-auth-hero nx-halftone" style={nxAuthHeroStyle}>
          <span style={nxAuthKickerStyle}>{kicker}</span>
          <h1 className="nx-auth-heading" style={nxAuthHeadingStyle}>{heading}</h1>
          <p style={nxAuthSubtitleStyle}>{subtitle}</p>
        </div>

        <div className="nx-auth-form-col" style={nxAuthFormColStyle}>
          {children}

          {hasFooter && (
            <Link href={footerHref as string} className="nx-wipe" style={nxAuthFooterCellStyle}>
              <span>
                {footerQuestion}{' '}
                <span style={nxAuthFooterLinkTextStyle}>{footerLinkText}</span>
              </span>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" aria-hidden>
                <path d="M2.5 8h11M9 3.5 13.5 8 9 12.5" />
              </svg>
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
