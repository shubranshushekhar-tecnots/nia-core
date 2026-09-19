'use client';

import { useState } from 'react';
import Logo from '@/components/Logo';
import { logout } from '@/lib/auth/actions';
import {
  breadcrumbSepStyle,
  dropdownItemStyle,
  dropdownStyle,
  orgSwitcherBtnStyle,
  topBarAvatarBtnStyle,
  topBarIconBtnStyle,
  topBarKbdStyle,
  topBarSearchBtnStyle,
  topBarSpacerStyle,
  topBarStyle,
} from './styles';
import CommandPalette from './CommandPalette';

export default function TopBar({ orgName, email }: { orgName: string | null; email: string }) {
  const [orgMenuOpen, setOrgMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const initials = email.slice(0, 2).toUpperCase();

  return (
    <header style={topBarStyle}>
      <Logo size={20} />
      <span style={breadcrumbSepStyle}>/</span>

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

      <form action={logout}>
        <button type="submit" style={topBarAvatarBtnStyle} title="Sign out">
          {initials}
        </button>
      </form>

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </header>
  );
}
