import type { ReactNode } from 'react';
import Link from 'next/link';
import { logout } from '@/lib/auth/actions';
import {
  consoleBodyRowStyle,
  consoleBrandMarkStyle,
  consoleBrandTextStyle,
  consoleGhostBtnStyle,
  consoleIdentityAvatarStyle,
  consoleIdentityColStyle,
  consoleIdentityNameStyle,
  consoleIdentitySubStyle,
  consoleIdentityWrapStyle,
  consoleInternalBadgeStyle,
  consoleMainColStyle,
  consoleNavGroupLabelStyle,
  consoleNavIconStyle,
  consoleNavItemStyle,
  consoleShellRootStyle,
  consoleSidebarFooterLabelStyle,
  consoleSidebarFooterStyle,
  consoleSidebarFooterValueStyle,
  consoleSidebarStyle,
  consoleStaffBadgeStyle,
  consoleStaffBarStyle,
  consoleTopBarSpacerStyle,
  consoleTopBarStyle,
} from './styles';
import { buildNavGroups } from './navGroups';

export default function ConsoleShell({
  activeNavId,
  email,
  paymentsEnabled = false,
  children,
}: {
  activeNavId: string;
  email: string;
  paymentsEnabled?: boolean;
  children: ReactNode;
}) {
  const groups = buildNavGroups(paymentsEnabled);
  const initials = email.slice(0, 2).toUpperCase();

  return (
    <div data-app-theme="" data-om-theme="light" style={consoleShellRootStyle}>
      <div style={consoleStaffBarStyle} />
      <header style={consoleTopBarStyle}>
        <span style={consoleBrandMarkStyle}>N</span>
        <span style={consoleBrandTextStyle}>Nia Console</span>
        <span style={consoleStaffBadgeStyle}>STAFF CONSOLE</span>
        <span style={consoleInternalBadgeStyle}>INTERNAL</span>
        <span style={consoleTopBarSpacerStyle} />
        <div style={consoleIdentityWrapStyle}>
          <span style={consoleIdentityAvatarStyle}>{initials}</span>
          <div style={consoleIdentityColStyle}>
            <span style={consoleIdentityNameStyle}>{email}</span>
            <span style={consoleIdentitySubStyle}>Nia staff</span>
          </div>
        </div>
        <form action={logout}>
          <button type="submit" style={consoleGhostBtnStyle}>
            Sign out
          </button>
        </form>
      </header>

      <div style={consoleBodyRowStyle}>
        <nav style={consoleSidebarStyle}>
          {groups
            .filter((g) => g.items.length > 0)
            .map((group) => (
              <div key={group.label}>
                <div style={consoleNavGroupLabelStyle}>{group.label}</div>
                {group.items.map((n) => {
                  const active = n.id === activeNavId;
                  const enabled = Boolean(n.href);
                  const content = (
                    <>
                      <span style={consoleNavIconStyle(active)}>{n.icon}</span>
                      <span style={{ flex: 1, textAlign: 'left', fontSize: 13 }}>{n.label}</span>
                    </>
                  );
                  return enabled ? (
                    <Link key={n.id} href={n.href!} style={consoleNavItemStyle(active, true)}>
                      {content}
                    </Link>
                  ) : (
                    <span key={n.id} style={consoleNavItemStyle(active, false)}>
                      {content}
                    </span>
                  );
                })}
              </div>
            ))}
          <span style={{ flex: 1 }} />
          <div style={consoleSidebarFooterStyle}>
            <span style={consoleSidebarFooterLabelStyle}>Console build</span>
            <span style={consoleSidebarFooterValueStyle}>Slice 3</span>
          </div>
        </nav>

        <div style={consoleMainColStyle}>{children}</div>
      </div>
    </div>
  );
}
