'use client';

import { useEffect, useState, type ReactNode } from 'react';
import AuthBackground from './AuthBackground';
import { authCardStyle, authFooterStyle, brandRowStyle, signinRootStyle, themeToggleStyle } from './styles';

const STORAGE_KEY = 'nia-om-theme';
type OmTheme = 'dark' | 'light';

function useOmTheme() {
  const [theme, setTheme] = useState<OmTheme>('light');

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') setTheme(stored);
  }, []);

  const toggle = () => {
    setTheme((current) => {
      const next: OmTheme = current === 'dark' ? 'light' : 'dark';
      window.localStorage.setItem(STORAGE_KEY, next);
      return next;
    });
  };

  return { theme, toggle };
}

// Shared chrome for every auth screen (login, signup, forgot/reset password,
// onboarding): background, brand mark, card, footer slot, and the
// data-om-theme light/dark toggle scoped to [data-auth-theme] (the auth
// screens' own light-indigo palette — distinct from the app shell's
// Midnight Navy/rust [data-app-theme], which applies only post-login).
export default function AuthShell({
  narrow = false,
  footer,
  children,
}: {
  narrow?: boolean;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const { theme, toggle } = useOmTheme();

  return (
    <div data-auth-theme="" data-om-theme={theme} style={signinRootStyle}>
      <AuthBackground />

      <button
        type="button"
        onClick={toggle}
        aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        style={themeToggleStyle}
      >
        {theme === 'dark' ? '\u2600' : '\u263D'}
      </button>

      <div
        style={{
          position: 'relative',
          zIndex: 2,
          width: 400,
          maxWidth: '100%',
          margin: 'auto 0',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
        }}
      >
        <div style={brandRowStyle}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="Nia Core" style={{ height: 28, width: 'auto' }} />
        </div>

        <div style={authCardStyle(narrow)}>{children}</div>

        {footer && <div style={authFooterStyle}>{footer}</div>}
      </div>
    </div>
  );
}
