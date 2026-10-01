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
  consoleNavIconStyle,
  consoleNavItemStyle,
  consoleShellRootStyle,
  consoleSidebarFooterLabelStyle,
  consoleSidebarFooterStyle,
  consoleSidebarFooterValueStyle,
  consoleSidebarStyle,
  consoleTopBarSpacerStyle,
  consoleTopBarStyle,
} from './styles';

// Ported from designs/Nia Console (superadmin).html's NAV array. Only
// 'directory' is a real route in Slice 1 (docs/plans/console-plan.md §5a);
// the rest render inert (matches decision 3 — the full nav is shown for
// design fidelity — without linking anywhere that doesn't exist yet).
//
// 'users' (Slice 3e) is the one entry NOT in the design's own NAV array
// (confirmed via `grep -o 'NAV *= *\[[^]]*\]'` against the design file —
// it lists exactly the 7 other ids below, nothing named "users"). The
// design's Directory screen conceptually folds org/user search into one
// screen with a type filter (console-plan.md §1's screen-mapping table),
// but that filter was never built — see ConsoleDirectoryClient's own doc
// comment. Since search-by-email/name is an explicit v1 requirement
// (step 12) with no existing destination to reach it from, a real nav
// entry is added here (peer to 'directory', both list/search screens);
// its detail screen (`/console/users/:userId`) intentionally gets no nav
// entry of its own, same as Org Detail — reached only by a row/member
// click, never the sidebar.
//
// 'notify' (Subscription Phase 5, Slice 3, docs/plans/subscription-model.md
// decision 1) was the one design-ported entry still inert through Slice 3e
// — relabeled "Announcements" and given a real href now that the screen
// exists, same label the design's own copy uses for this concept.
//
// 'usage' (Console v2 Slice 5) is, like 'users' above, a real nav entry not
// present in the original ported design — added as its own peer entry
// (rather than folded into 'dash'/Platform, which stayed inert pending
// Slice 6's dashboard) since the token usage page shipped before the
// dashboard home did.
//
// 'dash' (Console v2 Slice 6) now gets its own real href — the platform
// dashboard home (orgs/users/active-users, runs per day, rows moved,
// tokens+cost, needs-attention) — rather than becoming the new `/console`
// root: Directory (`/console`) already has that slot and an established
// bookmark/link surface (e.g. Org Detail's breadcrumb always points at
// `/console`), so Platform is a new, separate route like 'usage' and
// 'users' before it, not a replacement.
const NAV: Array<{ id: string; label: string; icon: string; href?: string }> = [
  { id: 'dash', label: 'Platform', icon: '\u25D1', href: '/console/dashboard' },
  { id: 'directory', label: 'Directory', icon: '\u25A4', href: '/console' },
  { id: 'users', label: 'Users', icon: '\u25CB', href: '/console/users' },
  { id: 'notify', label: 'Announcements', icon: '\u25CD', href: '/console/announcements' },
  { id: 'usage', label: 'Token Usage', icon: '\u25C6', href: '/console/usage' },
  { id: 'revenue', label: 'Revenue', icon: '\u25C8' },
  { id: 'invoices', label: 'Invoices', icon: '\u25A6' },
  { id: 'support', label: 'Support', icon: '\u25D4' },
  { id: 'settings', label: 'Settings', icon: '\u2699' },
];

export default function ConsoleShell({
  activeNavId,
  email,
  children,
}: {
  activeNavId: string;
  email: string;
  children: ReactNode;
}) {
  const initials = email.slice(0, 2).toUpperCase();

  return (
    <div data-app-theme="" data-om-theme="light" style={consoleShellRootStyle}>
      <header style={consoleTopBarStyle}>
        <span style={consoleBrandMarkStyle}>N</span>
        <span style={consoleBrandTextStyle}>Nia Console</span>
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
          {NAV.map((n) => {
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
          <span style={{ flex: 1 }} />
          <div style={consoleSidebarFooterStyle}>
            <span style={consoleSidebarFooterLabelStyle}>Console build</span>
            <span style={consoleSidebarFooterValueStyle}>Slice 1</span>
          </div>
        </nav>

        <div style={consoleMainColStyle}>{children}</div>
      </div>
    </div>
  );
}
