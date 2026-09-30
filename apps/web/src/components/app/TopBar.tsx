'use client';

import { useState } from 'react';
import Link from 'next/link';
import { logout, switchOrg } from '@/lib/auth/actions';
import { clearStoredBearerToken } from '@/lib/auth/browserSession';
import Avatar from '@/components/Avatar';
import Logo from '@/components/Logo';
import { useAppShellStore } from './store';
import { initials } from './home/RightPanel';
import {
  navWordmarkStyle,
  nxBreadcrumbSepStyle,
  nxDropdownItemStyle,
  nxDropdownStyle,
  nxOrgSwitcherBtnStyle,
  nxPageCrumbCurrentStyle,
  nxPageCrumbLinkStyle,
  nxTopBarCellStyle,
  nxTopBarLogoCellStyle,
  nxTopBarSearchCellStyle,
  nxTopBarStyle,
  profileEmailRowStyle,
  profileEmailTextStyle,
  topBarInitialsStyle,
  topBarKbdStyle,
  topBarSearchBtnFillStyle,
  topBarSearchLabelStyle,
  topBarSpacerStyle,
  topBarSquareCellStyle,
} from './styles';
import { NxBellIcon, NxSearchIcon } from '@/components/canvas/navIcons';
import CommandPalette from './CommandPalette';

// Wordmark hides below this cell width so "NIA CORE" never clips against
// the logo cell's right border while the sidebar (which this cell's width
// mirrors) is being dragged narrower.
const LOGO_CELL_WORDMARK_MIN_WIDTH = 120;

// Optional page-path crumbs (e.g. "Projects / <project name>") rendered
// right after the org switcher, in the same header row — pages must not
// also render their own duplicate breadcrumb below this one.
export type TopBarCrumb = { label: string; href?: string };

export default function TopBar({
  orgName,
  email,
  userId,
  fullName,
  crumbs,
  orgs,
  activeOrgId,
}: {
  orgName: string | null;
  email: string;
  /** Seed for the generated avatar — the current user's id. */
  userId: string;
  /** Used for the avatar cell's initials — same logic as the right panel. */
  fullName: string | null;
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
  // Read-only: the sidebar (Sidebar.tsx) is this cell's only writer, via
  // its drag handle / collapse toggle. TopBar and Sidebar are siblings
  // (see e.g. app/app/page.tsx), not parent/child, so the store is the
  // only way this cell's width can track the live rail width.
  const railW = useAppShellStore((s) => s.railW);
  const showWordmark = railW >= LOGO_CELL_WORDMARK_MIN_WIDTH;

  return (
    <header style={nxTopBarStyle}>
      {/* Logo cell — same unlinked/unlabeled <Logo> the sidebar used to
          render at this spot (no href or aria-label existed on it before
          this move either, so none is added here). */}
      <div className="nx-wipe" style={nxTopBarLogoCellStyle(railW)}>
        <Logo size={40} showWordmark={false} />
        {showWordmark && <span style={navWordmarkStyle}>Nia Core</span>}
      </div>

      <div className="nx-wipe" style={{ ...nxTopBarCellStyle(), position: 'relative' }}>
        <button type="button" style={nxOrgSwitcherBtnStyle} onClick={() => setOrgMenuOpen((v) => !v)}>
          <span>{orgName ?? 'Personal workspace'}</span>
          <span aria-hidden style={{ fontSize: 10, color: 'var(--nx-ink-2)', lineHeight: 1 }}>{'\u25BE'}</span>
        </button>
        {orgMenuOpen && (
          <div style={nxDropdownStyle} onMouseLeave={() => setOrgMenuOpen(false)}>
            {orgs && orgs.length > 1 ? (
              <>
                {orgs.map((org) => (
                  <form key={org.id} action={switchOrg.bind(null, org.id)}>
                    <button
                      type="submit"
                      style={{
                        ...nxDropdownItemStyle,
                        fontWeight: org.id === activeOrgId ? 600 : 400,
                        color: org.id === activeOrgId ? 'var(--nx-ink)' : undefined,
                      }}
                      disabled={org.id === activeOrgId}
                    >
                      {org.name}
                    </button>
                  </form>
                ))}
              </>
            ) : (
              <div style={{ ...nxDropdownItemStyle, fontWeight: 600, cursor: 'default' }}>
                {orgName ?? 'Personal workspace'}
              </div>
            )}
            <div style={{ height: 1, background: 'var(--nx-line)', margin: '4px 0' }} />
            {orgName === null ? (
              <a href="/onboarding" style={{ ...nxDropdownItemStyle, textDecoration: 'none', display: 'block' }}>
                Create organization
              </a>
            ) : (
              <button type="button" style={{ ...nxDropdownItemStyle, color: 'var(--nx-ink-3)' }} disabled>
                Create organization {'\u2014'} soon
              </button>
            )}
          </div>
        )}
      </div>

      {crumbs && crumbs.length > 0 && (
        <div className="nx-wipe" style={nxTopBarCellStyle()}>
          {crumbs.map((crumb, i) => (
            <span key={crumb.label} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={nxBreadcrumbSepStyle}>/</span>
              {crumb.href && i < crumbs.length - 1 ? (
                <Link href={crumb.href} style={nxPageCrumbLinkStyle}>
                  {crumb.label}
                </Link>
              ) : (
                <span style={nxPageCrumbCurrentStyle}>{crumb.label}</span>
              )}
            </span>
          ))}
        </div>
      )}

      <span style={topBarSpacerStyle} />

      <div className="nx-wipe" style={nxTopBarSearchCellStyle}>
        <button type="button" style={topBarSearchBtnFillStyle} onClick={() => setPaletteOpen(true)}>
          <NxSearchIcon size={15} />
          <span style={topBarSearchLabelStyle}>Search or run</span>
          <span style={topBarKbdStyle}>{'\u2318K'}</span>
        </button>
      </div>

      <div className="nx-wipe nx-row-disabled" style={topBarSquareCellStyle(true)}>
        <button
          type="button"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: 'default',
            color: 'var(--nx-ink-disabled)',
          }}
          disabled
          title="Notifications — soon"
        >
          <NxBellIcon size={16} />
        </button>
      </div>

      <div className="nx-wipe" style={{ ...topBarSquareCellStyle(false), position: 'relative' }}>
        <button
          type="button"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            height: '100%',
            padding: 0,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
          }}
          onClick={() => setProfileMenuOpen((v) => !v)}
          title={email}
        >
          <span style={topBarInitialsStyle}>{initials(fullName)}</span>
        </button>
        {profileMenuOpen && (
          <div style={{ ...nxDropdownStyle, right: 0, left: 'auto' }} onMouseLeave={() => setProfileMenuOpen(false)}>
            <div style={profileEmailRowStyle}>
              <Avatar seed={userId} size={24} title={email} />
              <span style={profileEmailTextStyle}>{email}</span>
            </div>
            <div style={{ height: 1, background: 'var(--nx-line)', margin: '4px 0' }} />
            <form action={logout}>
              {/* The server action clears the httpOnly session cookie;
                  this clears the localStorage bearer token (lib/auth/
                  browserSession.ts) used for Client Component API calls,
                  which the server action has no way to reach. */}
              <button
                type="submit"
                onClick={() => clearStoredBearerToken()}
                style={{ ...nxDropdownItemStyle, color: 'var(--nx-danger-text)' }}
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
