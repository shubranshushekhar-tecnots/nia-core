'use client';

import { useState } from 'react';
import Link from 'next/link';
import { logout, switchOrg } from '@/lib/auth/actions';
import { clearStoredBearerToken } from '@/lib/auth/browserSession';
import Avatar from '@/components/Avatar';
import {
  breadcrumbSepStyle,
  dropdownItemStyle,
  dropdownStyle,
  orgSwitcherBtnStyle,
  pageCrumbCurrentStyle,
  pageCrumbLinkStyle,
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
  userId,
  crumbs,
  orgs,
  activeOrgId,
}: {
  orgName: string | null;
  email: string;
  /** Seed for the generated avatar — the current user's id. */
  userId: string;
  crumbs?: TopBarCrumb[];
  /**
   * Org switcher (Subscription Phase 2): every org this user belongs to.
   * Optional so call sites that haven't been updated yet (e.g. the
   * Connections redesign) keep compiling/rendering unchanged — with this
   * omitted, the switcher falls back to its pre-switcher single-org
   * display.
   */
  orgs?: { id: string; name: string; slug: string }[];
  activeOrgId?: string | null;
}) {
  const [orgMenuOpen, setOrgMenuOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  return (
    <header style={topBarStyle}>
      <div style={{ position: 'relative' }}>
        <button type="button" style={orgSwitcherBtnStyle} onClick={() => setOrgMenuOpen((v) => !v)}>
          <span>{orgName ?? 'Personal workspace'}</span>
          <span aria-hidden style={{ fontSize: 10, color: 'var(--text-4)', lineHeight: 1 }}>{'\u25BE'}</span>
        </button>
        {orgMenuOpen && (
          <div style={dropdownStyle} onMouseLeave={() => setOrgMenuOpen(false)}>
            {orgs && orgs.length > 1 ? (
              <>
                {orgs.map((org) => (
                  <form key={org.id} action={switchOrg.bind(null, org.id)}>
                    <button
                      type="submit"
                      style={{
                        ...dropdownItemStyle,
                        fontWeight: org.id === activeOrgId ? 600 : 400,
                        color: org.id === activeOrgId ? 'var(--text-1)' : undefined,
                      }}
                      disabled={org.id === activeOrgId}
                    >
                      {org.name}
                    </button>
                  </form>
                ))}
              </>
            ) : (
              <div style={{ ...dropdownItemStyle, fontWeight: 600, cursor: 'default' }}>
                {orgName ?? 'Personal workspace'}
              </div>
            )}
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
          style={{ ...topBarAvatarBtnStyle, padding: 0, background: 'transparent', border: 'none' }}
          onClick={() => setProfileMenuOpen((v) => !v)}
          title={email}
        >
          <Avatar seed={userId} size={26} title={email} />
        </button>
        {profileMenuOpen && (
          <div style={{ ...dropdownStyle, right: 0, left: 'auto' }} onMouseLeave={() => setProfileMenuOpen(false)}>
            <div style={profileEmailRowStyle}>
              <Avatar seed={userId} size={24} title={email} />
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
