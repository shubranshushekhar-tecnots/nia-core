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

type NavItem = { id: string; label: string; icon: string; href?: string };
type NavGroup = { label: string; items: NavItem[] };

// Console redesign Slice 3 (grouped sidebar). Replaces the old flat NAV
// array. Same "no dead links" rule as before: an item with no `href` isn't
// a route yet and renders inert/dimmed (consoleNavItemStyle's `enabled`
// flag) rather than disappearing — this lets each later slice (4-9) flip
// exactly one `href` live as its page ships, with no other reshuffling.
//
// IDs are kept stable across the Slice 3 rename for existing pages' already-
// shipped `activeNavId="..."` props (dash/directory/users/notify/usage) —
// only the group structure and some labels changed, not the ids.
const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Dashboard',
    items: [
      { id: 'dash', label: 'Overview', icon: '\u25D1', href: '/console/dashboard' },
      { id: 'usage', label: 'Token Analytics', icon: '\u25C6', href: '/console/usage' },
      { id: 'health', label: 'System Health', icon: '\u25C9', href: '/console/health' },
    ],
  },
  {
    label: 'Users & Access',
    items: [
      { id: 'users', label: 'Users', icon: '\u25CB', href: '/console/users' },
      { id: 'directory', label: 'Organizations', icon: '\u25A4', href: '/console' },
      { id: 'staff', label: 'Platform Staff', icon: '\u25D4', href: '/console/staff' },
    ],
  },
  {
    label: 'Content',
    items: [
      { id: 'projects', label: 'Projects & Workflows', icon: '\u25A6', href: '/console/projects' },
    ],
  },
  {
    label: 'Platform',
    items: [
      { id: 'plans', label: 'Plans', icon: '\u25C8', href: '/console/plans' },
      { id: 'audit-logs', label: 'Audit Logs', icon: '\u2637', href: '/console/audit-logs' },
      { id: 'notify', label: 'Announcements', icon: '\u25CD', href: '/console/announcements' },
    ],
  },
  {
    label: 'Config',
    items: [
      { id: 'model-prices', label: 'Model Prices', icon: '\u2699', href: '/console/model-prices' },
    ],
  },
];

// Payments group — scope gap flagged in the plan: the spec asks for a group
// "shown only when payments are enabled," but no payments Console page is
// requested in this piece of work, and a placeholder "coming soon" page
// would itself be a dead link, which is explicitly disallowed. So the group
// is wired up (gated on `paymentsEnabled`) but stays empty until a real
// payments page exists — it renders nothing in either flag state today.
const PAYMENTS_GROUP: NavGroup = { label: 'Payments', items: [] };

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
  const groups = paymentsEnabled ? [...NAV_GROUPS, PAYMENTS_GROUP] : NAV_GROUPS;
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
