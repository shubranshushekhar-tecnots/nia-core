'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import type { ConsoleUsersPage } from '@/lib/api/consoleServer';
import { searchUsersAction } from '@/lib/console/actions';
import {
  consoleColAccountStyle,
  consoleColJoinedStyle,
  consoleColMembersStyle,
  consoleContentStyle,
  consoleEmptyStyle,
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
  consoleRowNumberStyle,
  consoleRowStyle,
  consoleSearchStyle,
  consoleTableHeadRowStyle,
  consoleTableStyle,
  consoleToolbarRowStyle,
} from './styles';

/**
 * Console v1 Users screen (docs/plans/console-plan.md build order step 12,
 * Slice 3e). Not a literal port from the design — its own NAV array has no
 * "Users" destination at all (see ConsoleShell's doc comment) — so this
 * mirrors ConsoleDirectoryClient's proven list-screen layout (header +
 * search + table + Load more) instead, the same pattern this Console
 * already uses for its one other list/search screen.
 *
 * Unlike ConsoleDirectoryClient's `search` (a client-side filter over
 * already-loaded rows), GET /console/users does real server-side search by
 * email/name (the user's own spec: "search by email/name, paged with
 * total"), so typing here debounces into a real re-fetch from offset 0 via
 * searchUsersAction, not a local .filter().
 */
export default function ConsoleUsersClient({ initialPage }: { initialPage: ConsoleUsersPage }) {
  const [users, setUsers] = useState(initialPage.users);
  const [offset, setOffset] = useState(initialPage.offset + initialPage.users.length);
  const [total, setTotal] = useState(initialPage.total);
  const [hasMore, setHasMore] = useState(initialPage.hasMore);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [query, setQuery] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setLoadError(null);
      startTransition(async () => {
        try {
          const page = await searchUsersAction(query.trim(), 0);
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
  }, [query]);

  function handleLoadMore() {
    setLoadError(null);
    startTransition(async () => {
      try {
        const page = await searchUsersAction(query.trim(), offset);
        setUsers((prev) => [...prev, ...page.users]);
        setOffset(page.offset + page.users.length);
        setTotal(page.total);
        setHasMore(page.hasMore);
      } catch {
        setLoadError("Couldn't load more users. Try again.");
      }
    });
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
      </div>

      <div style={consoleTableStyle}>
        <div style={consoleTableHeadRowStyle}>
          <span style={consoleColAccountStyle}>User</span>
          <span style={consoleColMembersStyle}>Orgs</span>
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
              <span style={consoleRowNumberStyle}>{u.orgCount}</span>
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
