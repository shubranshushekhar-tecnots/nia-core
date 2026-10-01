'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import type { ConsoleOrg, ConsoleOrgsPage } from '@/lib/api/consoleServer';
import { loadMoreOrgsAction } from '@/lib/console/actions';
import {
  consoleColAccountStyle,
  consoleColMembersStyle,
  consoleColPlanStyle,
  consoleColRunsStyle,
  consoleColStatusStyle,
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
  consolePillStyle,
  consoleRowAccountCellStyle,
  consoleRowKindStyle,
  consoleRowLinkStyle,
  consoleRowNameColStyle,
  consoleRowNameStyle,
  consoleRowNumberStyle,
  consoleRowPlanStyle,
  consoleRowStyle,
  consoleSearchStyle,
  consoleTableHeadRowStyle,
  consoleTableStyle,
  consoleToolbarRowStyle,
} from './styles';

/**
 * Console v1 Directory screen (docs/plans/console-plan.md §5a, Slice 1).
 * Markup/styles ported from designs/Nia Console (superadmin).html's
 * Directory template. Deliberately narrower than the design in a few
 * places, matching what's actually built so far — not non-functional
 * controls:
 *  - No "Accounts / Recently deleted" tabs: org delete/purge is out of v1
 *    entirely (console-plan.md §1's screen-mapping table), so there is
 *    nothing a second tab would ever show.
 *  - No type/plan/status filter dropdowns: every org apps/api returns today
 *    has the same hardcoded planTier/status (org_plan lands in step 7,
 *    suspension in step 9 — see the doc comment on GET /console/orgs), so
 *    those selects would filter nothing.
 *  - No per-row "..." action menu: suspend/delete are Slice 3+, not built
 *    yet. Clicking a row itself now navigates to Org Detail (Slice 2),
 *    matching the design's own row-click behavior (`o.open` in
 *    designs/Nia Console (superadmin).html), just as a real route instead
 *    of a client-side view-state toggle.
 *
 * `search` filters only the orgs already loaded into the browser, client-
 * side (matching the design's own client-side `q` filter over its mock
 * data) rather than re-fetching per keystroke — GET /console/orgs already
 * writes one staff_audit_log row per page load; a per-keystroke audit row
 * would be excessive noise for a client-side-only filter. See
 * console-plan.md decision 10 for the full tradeoff this implies now that
 * the server paginates: a search term can only ever match a loaded org, not
 * the full `total` count shown in the header.
 *
 * Pagination (Slice 1 review fix): `page.tsx` fetches only the first page
 * server-side; "Load more" below calls `loadMoreOrgsAction` (a Server
 * Action) to fetch subsequent pages and appends them to `orgs` — the
 * header's "Showing X of N" always reflects the server's real `total`, so a
 * result set is never silently truncated with no indication more exists.
 */
export default function ConsoleDirectoryClient({ initialPage }: { initialPage: ConsoleOrgsPage }) {
  const [orgs, setOrgs] = useState<ConsoleOrg[]>(initialPage.orgs);
  const [offset, setOffset] = useState(initialPage.offset + initialPage.orgs.length);
  const [total, setTotal] = useState(initialPage.total);
  const [hasMore, setHasMore] = useState(initialPage.hasMore);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return orgs;
    return orgs.filter((o) => `${o.name} ${o.planTier}`.toLowerCase().includes(q));
  }, [orgs, query]);

  function handleLoadMore() {
    setLoadError(null);
    startTransition(async () => {
      try {
        const page = await loadMoreOrgsAction(offset);
        setOrgs((prev) => [...prev, ...page.orgs]);
        setOffset(page.offset + page.orgs.length);
        setTotal(page.total);
        setHasMore(page.hasMore);
      } catch {
        setLoadError("Couldn't load more accounts. Try again.");
      }
    });
  }

  return (
    <div style={consoleContentStyle}>
      <div style={consoleHeaderRowStyle}>
        <div style={consoleHeaderTitleColStyle}>
          <span style={consoleHeaderTitleStyle}>Organizations</span>
          <span style={consoleHeaderSubStyle}>
            Showing {orgs.length} of {total} organizations
          </span>
        </div>
      </div>

      <div style={consoleToolbarRowStyle}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search accounts"
          spellCheck={false}
          style={consoleSearchStyle}
        />
      </div>

      <div style={consoleTableStyle}>
        <div style={consoleTableHeadRowStyle}>
          <span style={consoleColAccountStyle}>Account</span>
          <span style={consoleColPlanStyle}>Plan</span>
          <span style={consoleColMembersStyle}>Members</span>
          <span style={consoleColRunsStyle}>Runs 30d</span>
          <span style={consoleColStatusStyle}>Status</span>
        </div>

        {shown.length === 0 && <div style={consoleEmptyStyle}>No accounts match &ldquo;{query}&rdquo;.</div>}

        {shown.map((o) => (
          <Link key={o.id} href={`/console/orgs/${o.id}`} style={consoleRowLinkStyle}>
            <div style={consoleRowStyle}>
              <span style={consoleRowAccountCellStyle}>
                <span style={consoleMonoStyle}>{initialsOf(o.name)}</span>
                <span style={consoleRowNameColStyle}>
                  <span style={consoleRowNameStyle}>{o.name}</span>
                  <span style={consoleRowKindStyle}>Organization</span>
                </span>
              </span>
              <span style={consoleRowPlanStyle}>{o.planTier}</span>
              <span style={consoleRowNumberStyle}>{o.memberCount}</span>
              <span style={consoleRowNumberStyle}>{o.runs30d}</span>
              <span style={consoleColStatusStyle}>
                <span style={consolePillStyle(o.status === 'Active' ? 'ok' : 'neutral')}>{o.status}</span>
              </span>
            </div>
          </Link>
        ))}
      </div>

      {hasMore && (
        <div style={consoleLoadMoreRowStyle}>
          <button type="button" onClick={handleLoadMore} disabled={isPending} style={consoleGhostBtnStyle}>
            {isPending ? 'Loading…' : 'Load more'}
          </button>
          {loadError && <span style={consoleLoadMoreErrorStyle}>{loadError}</span>}
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
