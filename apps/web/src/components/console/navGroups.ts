// `icon` is a lookup key into the NAV_ICON map (apps/web/src/components/
// console/ConsoleShell.tsx), not a rendered glyph/component — this file
// stays JSX-free (and importable by navGroups.test.ts under vitest's
// esbuild/"jsx":"preserve" setup, see that test's comment) by never
// touching apps/web/src/components/console/icons.tsx, which is a real
// .tsx module.
export type NavIconKey =
  | 'overview'
  | 'token-analytics'
  | 'system-health'
  | 'users'
  | 'organizations'
  | 'platform-staff'
  | 'access-requests'
  | 'invitations'
  | 'projects-workflows'
  | 'plans'
  | 'audit-logs'
  | 'announcements'
  | 'model-prices';

export type NavItem = { id: string; label: string; icon: NavIconKey; href?: string };
export type NavGroup = { label: string; items: NavItem[] };

// Console redesign Slice 3 (grouped sidebar). Replaces the old flat NAV
// array. Same "no dead links" rule as before: an item with no `href` isn't
// a route yet and renders inert/dimmed (consoleNavItemStyle's `enabled`
// flag) rather than disappearing — this lets each later slice (4-9) flip
// exactly one `href` live as its page ships, with no other reshuffling.
//
// IDs are kept stable across the Slice 3 rename for existing pages' already-
// shipped `activeNavId="..."` props (dash/directory/users/notify/usage) —
// only the group structure and some labels changed, not the ids.
//
// Pulled out of ConsoleShell.tsx into this plain .ts module (Slice 10) so
// buildNavGroups() below is unit-testable without a jsdom/@testing-library
// render setup — tsconfig.json's "jsx": "preserve" means vite's default
// esbuild transform can't parse a .tsx file for vitest, but a JSX-free .ts
// module needs no special handling (apps/web/vitest.config.ts).
const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Dashboard',
    items: [
      { id: 'dash', label: 'Overview', icon: 'overview', href: '/console/dashboard' },
      { id: 'usage', label: 'Token Analytics', icon: 'token-analytics', href: '/console/usage' },
      { id: 'health', label: 'System Health', icon: 'system-health', href: '/console/health' },
    ],
  },
  {
    label: 'Users & Access',
    items: [
      { id: 'users', label: 'Users', icon: 'users', href: '/console/users' },
      { id: 'directory', label: 'Organizations', icon: 'organizations', href: '/console' },
      { id: 'staff', label: 'Platform Staff', icon: 'platform-staff', href: '/console/staff' },
      { id: 'access-requests', label: 'Access Requests', icon: 'access-requests', href: '/console/access-requests' },
      { id: 'invitations', label: 'Invitations', icon: 'invitations', href: '/console/invitations' },
    ],
  },
  {
    label: 'Content',
    items: [
      { id: 'projects', label: 'Projects & Workflows', icon: 'projects-workflows', href: '/console/projects' },
    ],
  },
  {
    label: 'Platform',
    items: [
      { id: 'plans', label: 'Plans', icon: 'plans', href: '/console/plans' },
      { id: 'audit-logs', label: 'Audit Logs', icon: 'audit-logs', href: '/console/audit-logs' },
      { id: 'notify', label: 'Announcements', icon: 'announcements', href: '/console/announcements' },
    ],
  },
  {
    label: 'Config',
    items: [
      { id: 'model-prices', label: 'Model Prices', icon: 'model-prices', href: '/console/model-prices' },
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

export function buildNavGroups(paymentsEnabled: boolean): NavGroup[] {
  return paymentsEnabled ? [...NAV_GROUPS, PAYMENTS_GROUP] : NAV_GROUPS;
}
