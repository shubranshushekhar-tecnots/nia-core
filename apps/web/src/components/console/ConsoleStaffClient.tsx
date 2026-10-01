'use client';

import { useState, useTransition } from 'react';
import type { ConsoleStaffPage } from '@/lib/api/consoleServer';
import { loadMoreStaffAction } from '@/lib/console/actions';
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
  consolePillStyle,
  consoleRowAccountCellStyle,
  consoleRowJoinedCellStyle,
  consoleRowKindStyle,
  consoleRowNameColStyle,
  consoleRowNameStyle,
  consoleRowStyle,
  consoleTableHeadRowStyle,
  consoleTableStyle,
} from './styles';

/**
 * Console redesign plan's Slice 5 — Platform Staff page. Same "load first
 * page server-side, Load more via a Server Action" list-screen pattern as
 * ConsoleUsersClient, minus search (the plan doesn't ask for it). Read-only
 * — staff are granted/revoked only via the manageStaff.ts CLI, never from
 * this page, hence the fixed note below instead of any add/revoke control.
 */
export default function ConsoleStaffClient({ initialPage }: { initialPage: ConsoleStaffPage }) {
  const [staff, setStaff] = useState(initialPage.staff);
  const [offset, setOffset] = useState(initialPage.offset + initialPage.staff.length);
  const [total, setTotal] = useState(initialPage.total);
  const [hasMore, setHasMore] = useState(initialPage.hasMore);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleLoadMore() {
    setLoadError(null);
    startTransition(async () => {
      try {
        const page = await loadMoreStaffAction(offset);
        setStaff((prev) => [...prev, ...page.staff]);
        setOffset(page.offset + page.staff.length);
        setTotal(page.total);
        setHasMore(page.hasMore);
      } catch {
        setLoadError("Couldn't load more staff. Try again.");
      }
    });
  }

  return (
    <div style={consoleContentStyle}>
      <div style={consoleHeaderRowStyle}>
        <div style={consoleHeaderTitleColStyle}>
          <span style={consoleHeaderTitleStyle}>Platform Staff</span>
          <span style={consoleHeaderSubStyle}>
            Showing {staff.length} of {total} staff — staff are granted via the CLI only.
          </span>
        </div>
      </div>

      <div style={consoleTableStyle}>
        <div style={consoleTableHeadRowStyle}>
          <span style={consoleColAccountStyle}>Staff member</span>
          <span style={consoleColMembersStyle}>2FA</span>
          <span style={consoleColJoinedStyle}>Granted by</span>
          <span style={consoleColJoinedStyle}>Granted</span>
          <span style={consoleColJoinedStyle}>Last sign-in</span>
        </div>

        {loadError && <div style={consoleLoadMoreErrorStyle}>{loadError}</div>}

        {!loadError && staff.length === 0 && <div style={consoleEmptyStyle}>No active staff.</div>}

        {staff.map((s) => (
          <div key={s.userId} style={consoleRowStyle}>
            <span style={consoleRowAccountCellStyle}>
              <span style={consoleMonoStyle}>{initialsOf(s.name || s.email)}</span>
              <span style={consoleRowNameColStyle}>
                <span style={consoleRowNameStyle}>{s.name || s.email}</span>
                <span style={consoleRowKindStyle}>{s.email}</span>
              </span>
            </span>
            <span style={consoleColMembersStyle}>
              <span style={consolePillStyle(s.twoFactorEnabled ? 'ok' : 'warn')}>
                {s.twoFactorEnabled ? 'Enabled' : 'Disabled'}
              </span>
            </span>
            <span style={consoleRowJoinedCellStyle}>{s.grantedBy.name || s.grantedBy.email}</span>
            <span style={consoleRowJoinedCellStyle}>{formatDate(s.grantedAt)}</span>
            <span style={consoleRowJoinedCellStyle}>{s.lastSignInAt ? formatDate(s.lastSignInAt) : 'Never'}</span>
          </div>
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
