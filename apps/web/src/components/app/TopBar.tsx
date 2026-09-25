'use client';

import { useState } from 'react';
import Link from 'next/link';
import { logout } from '@/lib/auth/actions';
import { clearStoredBearerToken } from '@/lib/auth/browserSession';
import {
  breadcrumbSepStyle,
  dropdownItemStyle,
  dropdownStyle,
  orgSwitcherBtnStyle,
  pageCrumbCurrentStyle,
  pageCrumbLinkStyle,
  profileAvatarStyle,
  profileEmailRowStyle,
  profileEmailTextStyle,
  topBarAvatarBtnStyle,
  topBarIconBtnStyle,
  topBarKbdStyle,
  topBarSearchBtnStyle,
  topBarSpacerStyle,
  topBarStyle,
} from './styles';
import CommandPalette from './CommandPalette';

// Optional page-path crumbs (e.g. "Projects / <project name>") rendered
// right after the org switcher, in the same header row — pages must not
// also render their own duplicate breadcrumb below this one.
export type TopBarCrumb = { label: string; href?: string };

export default function TopBar({
  orgName,
  email,
  crumbs,
}: {
  orgName: string | null;
  email: string;
  crumbs?: TopBarCrumb[];
}) {
  const [orgMenuOpen, setOrgMenuOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const initials = email.slice(0, 2).toUpperCase();

  return (
    <header style={topBarStyle}>
      <div style={{ position: 'relative' }}>
        <button type="button" style={orgSwitcherBtnStyle} onClick={() => setOrgMenuOpen((v) => !v)}>
          <span>{orgName ?? 'Personal workspace'}</span>
          <span aria-hidden style={{ fontSize: 10, color: 'var(--text-4)', lineHeight: 1 }}>{'\u25BE'}</span>
        </button>
        {orgMenuOpen && (
          <div style={dropdownStyle} onMouseLeave={() => setOrgMenuOpen(false)}>
            <div style={{ ...dropdownItemStyle, fontWeight: 600, cursor: 'default' }}>
              {orgName ?? 'Personal workspace'}
            </div>
            <div style={{ height: 1, background: 'var(--line)', margin: '4px 0' }} />
            {orgName === null ? (
              <a href="/onboarding" style={{ ...dropdownItemStyle, textDecoration: 'none', display: 'block' }}>
                Create organization
              </a>
            ) : (
              <button type="button" style={{ ...dropdownItemStyle, color: 'var(--text-3)' }} disabled>
                Create organization {'\u2014'} soon
              </button>
            )}
          </div>
        )}
      </div>

      {crumbs?.map((crumb, i) => (
        <span key={crumb.label} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={breadcrumbSepStyle}>/</span>
          {crumb.href && i < crumbs.length - 1 ? (
            <Link href={crumb.href} style={pageCrumbLinkStyle}>
              {crumb.label}
            </Link>
          ) : (
            <span style={pageCrumbCurrentStyle}>{crumb.label}</span>
          )}
        </span>
      ))}

      <span style={topBarSpacerStyle} />

      <button type="button" style={topBarSearchBtnStyle} onClick={() => setPaletteOpen(true)}>
        <span aria-hidden>{'\u26B2'}</span>
        <span>Search or run</span>
        <span style={topBarKbdStyle}>{'\u2318K'}</span>
      </button>

      <button
        type="button"
        style={{ ...topBarIconBtnStyle, cursor: 'default', color: 'var(--text-4)' }}
        disabled
        title="Notifications — soon"
      >
        <span aria-hidden>{'\u25D4'}</span>
      </button>

      <div style={{ position: 'relative' }}>
        <button
          type="button"
          style={topBarAvatarBtnStyle}
          onClick={() => setProfileMenuOpen((v) => !v)}
          title={email}
        >
          {initials}
        </button>
        {profileMenuOpen && (
          <div style={{ ...dropdownStyle, right: 0, left: 'auto' }} onMouseLeave={() => setProfileMenuOpen(false)}>
            <div style={profileEmailRowStyle}>
              <span style={profileAvatarStyle} aria-hidden>{initials}</span>
              <span style={profileEmailTextStyle}>{email}</span>
            </div>
            <div style={{ height: 1, background: 'var(--line)', margin: '4px 0' }} />
            <form action={logout}>
              {/* The server action clears the httpOnly session cookie;
                  this clears the localStorage bearer token (lib/auth/
                  browserSession.ts) used for Client Component API calls,
                  which the server action has no way to reach. */}
              <button
                type="submit"
                onClick={() => clearStoredBearerToken()}
                style={{ ...dropdownItemStyle, color: 'var(--bad)' }}
              >
                Sign out
              </button>
            </form>
          </div>
        )}
      </div>

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </header>
  );
}
