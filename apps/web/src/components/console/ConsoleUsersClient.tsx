'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import type { ConsolePlan, ConsoleUsersPage } from '@/lib/api/consoleServer';
import { searchUsersAction } from '@/lib/console/actions';
import {
  consoleColAccountStyle,
  consoleColJoinedStyle,
  consoleColPlanStyle,
  consoleColWorkspaceStyle,
  consoleContentStyle,
  consoleEmptyStyle,
  consoleFilterSelectStyle,
  consoleGhostBtnStyle,
  consoleHeaderRowStyle,
  consoleHeaderSubStyle,
  consoleHeaderTitleColStyle,
  consoleHeaderTitleStyle,
  consoleLoadMoreErrorStyle,
  consoleLoadMoreRowStyle,
  consoleMonoStyle,
  consoleRowAccountCellStyle,
  consoleRowJoinedCellStyle,
  consoleRowKindStyle,
  consoleRowLinkStyle,
  consoleRowNameColStyle,
  consoleRowNameStyle,
  consoleRowPlanStyle,
  consoleRowStyle,
  consoleRowWorkspaceStyle,
  consoleSearchStyle,
  consoleTableHeadRowStyle,
  consoleTableStyle,
  consoleToolbarRowStyle,
} from './styles';

// Role options a user's oldest org membership can have, plus the
// server's own "individual" pseudo-role for non-org users — mirrors
// ConsoleAnnouncementsClient's ROLE_OPTIONS plus the extra option, kept
// local since this is the only screen that filters on it.
const ROLE_FILTER_OPTIONS = ['owner', 'admin', 'member', 'viewer', 'individual'] as const;

/**
 * Console v1 Users screen (docs/plans/console-plan.md build order step 12,
 * Slice 3e; extended for the plan-visibility work's role/plan/workspace
 * filters and columns). Not a literal port from the design — its own NAV
 * array has no "Users" destination at all (see ConsoleShell's doc
 * comment) — so this mirrors ConsoleDirectoryClient's proven list-screen
 * layout (header + search + table + Load more) instead, the same pattern
 * this Console already uses for its one other list/search screen.
 *
 * Unlike ConsoleDirectoryClient's `search` (a client-side filter over
 * already-loaded rows), GET /console/users does real server-side search by
 * email/name (the user's own spec: "search by email/name, paged with
 * total"), so typing/filtering here debounces into a real re-fetch from
 * offset 0 via searchUsersAction, not a local .filter(). `plans` (passed
 * from the server page, same pattern as ConsoleOrgDetailClient) resolves
 * each row's `effectivePlanId` to a display name and populates the plan
 * filter's options — it's never refetched here.
 */
export default function ConsoleUsersClient({
  initialPage,
  plans,
}: {
  initialPage: ConsoleUsersPage;
  plans: ConsolePlan[];
}) {
  const [users, setUsers] = useState(initialPage.users);
  const [offset, setOffset] = useState(initialPage.offset + initialPage.users.length);
  const [total, setTotal] = useState(initialPage.total);
  const [hasMore, setHasMore] = useState(initialPage.hasMore);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [planFilter, setPlanFilter] = useState('');
  const [workspaceTypeFilter, setWorkspaceTypeFilter] = useState<'' | 'individual' | 'org'>('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const filters = {
    role: roleFilter || undefined,
    plan: planFilter || undefined,
    workspaceType: workspaceTypeFilter || undefined,
  };

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setLoadError(null);
      startTransition(async () => {
        try {
          const page = await searchUsersAction(query.trim(), 0, filters);
          setUsers(page.users);
          setOffset(page.offset + page.users.length);
          setTotal(page.total);
          setHasMore(page.hasMore);
        } catch {
          setLoadError("Couldn't search users. Try again.");
        }
      });
    }, 300);
    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, roleFilter, planFilter, workspaceTypeFilter]);

  function handleLoadMore() {
    setLoadError(null);
    startTransition(async () => {
      try {
        const page = await searchUsersAction(query.trim(), offset, filters);
        setUsers((prev) => [...prev, ...page.users]);
        setOffset(page.offset + page.users.length);
        setTotal(page.total);
        setHasMore(page.hasMore);
      } catch {
        setLoadError("Couldn't load more users. Try again.");
      }
    });
  }

  function planName(planId: string): string {
    return plans.find((p) => p.id === planId)?.name ?? planId;
  }

  return (
    <div style={consoleContentStyle}>
      <div style={consoleHeaderRowStyle}>
        <div style={consoleHeaderTitleColStyle}>
          <span style={consoleHeaderTitleStyle}>Users</span>
          <span style={consoleHeaderSubStyle}>
            Showing {users.length} of {total} users
          </span>
        </div>
      </div>

      <div style={consoleToolbarRowStyle}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or email"
          spellCheck={false}
          style={consoleSearchStyle}
        />
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          style={consoleFilterSelectStyle}
          aria-label="Filter by role"
        >
          <option value="">All roles</option>
          {ROLE_FILTER_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {r === 'individual' ? 'Individual' : r.charAt(0).toUpperCase() + r.slice(1)}
            </option>
          ))}
        </select>
        <select
          value={planFilter}
          onChange={(e) => setPlanFilter(e.target.value)}
          style={consoleFilterSelectStyle}
          aria-label="Filter by plan"
        >
          <option value="">All plans</option>
          {plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          value={workspaceTypeFilter}
          onChange={(e) => setWorkspaceTypeFilter(e.target.value as '' | 'individual' | 'org')}
          style={consoleFilterSelectStyle}
          aria-label="Filter by workspace type"
        >
          <option value="">All workspaces</option>
          <option value="individual">Individual</option>
          <option value="org">Org</option>
        </select>
      </div>

      <div style={consoleTableStyle}>
        <div style={consoleTableHeadRowStyle}>
          <span style={consoleColAccountStyle}>User</span>
          <span style={consoleColWorkspaceStyle}>Workspace</span>
          <span style={consoleColPlanStyle}>Plan</span>
          <span style={consoleColJoinedStyle}>Created</span>
        </div>

        {loadError && <div style={consoleLoadMoreErrorStyle}>{loadError}</div>}

        {!loadError && users.length === 0 && (
          <div style={consoleEmptyStyle}>{query ? `No users match "${query}".` : 'No users.'}</div>
        )}

        {users.map((u) => (
          <Link key={u.id} href={`/console/users/${u.id}`} style={consoleRowLinkStyle}>
            <div style={consoleRowStyle}>
              <span style={consoleRowAccountCellStyle}>
                <span style={consoleMonoStyle}>{initialsOf(u.name || u.email)}</span>
                <span style={consoleRowNameColStyle}>
                  <span style={consoleRowNameStyle}>{u.name || u.email}</span>
                  <span style={consoleRowKindStyle}>{u.email}</span>
                </span>
              </span>
              <span style={consoleRowWorkspaceStyle}>{workspaceLabel(u)}</span>
              <span style={consoleRowPlanStyle}>{planName(u.effectivePlanId)}</span>
              <span style={consoleRowJoinedCellStyle}>{formatDate(u.createdAt)}</span>
            </div>
          </Link>
        ))}
      </div>

      {hasMore && (
        <div style={consoleLoadMoreRowStyle}>
          <button type="button" onClick={handleLoadMore} disabled={isPending} style={consoleGhostBtnStyle}>
            {isPending ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}

// Users list's "Workspace" cell: role + org name(s) for an org member,
// else "Individual" — `u.orgs` is already ordered oldest-first by the
// API, same array `effectiveRole`/`effectivePlanId` are derived from.
function workspaceLabel(u: ConsoleUsersPage['users'][number]): string {
  if (u.workspaceType === 'individual' || u.orgs.length === 0) return 'Individual';
  const role = u.effectiveRole.charAt(0).toUpperCase() + u.effectiveRole.slice(1);
  const names = u.orgs.map((o) => o.orgName);
  const label = names.length > 1 ? `${names[0]} +${names.length - 1} more` : names[0];
  return `${role} · ${label}`;
}

function initialsOf(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
