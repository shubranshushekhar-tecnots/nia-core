'use client';

import { useState, useTransition } from 'react';
import type { ConsoleProjectsPage } from '@/lib/api/consoleServer';
import { loadMoreProjectsAction } from '@/lib/console/actions';
import {
  consoleColAccountStyle,
  consoleColRunStartedStyle,
  consoleColRunStatusStyle,
  consoleColRunsStyle,
  consoleContentStyle,
  consoleEmptyStyle,
  consoleGhostBtnStyle,
  consoleHeaderRowStyle,
  consoleHeaderSubStyle,
  consoleHeaderTitleColStyle,
  consoleHeaderTitleStyle,
  consoleLoadMoreErrorStyle,
  consoleLoadMoreRowStyle,
  consolePillStyle,
  consoleRowNumberStyle,
  consoleRowRunStartedCellStyle,
  consoleRowRunStatusCellStyle,
  consoleRowStyle,
  consoleTableHeadRowStyle,
  consoleTableStyle,
} from './styles';

/**
 * Console redesign plan's Slice 6 — Projects & Workflows page. Per-org
 * rollup only (project count, workflow count, most recent run) — same
 * "load first page server-side, Load more via a Server Action" list-screen
 * pattern as ConsoleStaffClient, minus search (the plan doesn't ask for
 * it). Deliberately never renders any workflow content/row data — the API
 * response itself has no such field.
 */
export default function ConsoleProjectsClient({ initialPage }: { initialPage: ConsoleProjectsPage }) {
  const [orgs, setOrgs] = useState(initialPage.orgs);
  const [offset, setOffset] = useState(initialPage.offset + initialPage.orgs.length);
  const [total, setTotal] = useState(initialPage.total);
  const [hasMore, setHasMore] = useState(initialPage.hasMore);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleLoadMore() {
    setLoadError(null);
    startTransition(async () => {
      try {
        const page = await loadMoreProjectsAction(offset);
        setOrgs((prev) => [...prev, ...page.orgs]);
        setOffset(page.offset + page.orgs.length);
        setTotal(page.total);
        setHasMore(page.hasMore);
      } catch {
        setLoadError("Couldn't load more orgs. Try again.");
      }
    });
  }

  return (
    <div style={consoleContentStyle}>
      <div style={consoleHeaderRowStyle}>
        <div style={consoleHeaderTitleColStyle}>
          <span style={consoleHeaderTitleStyle}>Projects & Workflows</span>
          <span style={consoleHeaderSubStyle}>
            Showing {orgs.length} of {total} orgs
          </span>
        </div>
      </div>

      <div style={consoleTableStyle}>
        <div style={consoleTableHeadRowStyle}>
          <span style={consoleColAccountStyle}>Organization</span>
          <span style={consoleColRunsStyle}>Projects</span>
          <span style={consoleColRunsStyle}>Workflows</span>
          <span style={consoleColRunStatusStyle}>Last run</span>
          <span style={consoleColRunStartedStyle}>Last run at</span>
        </div>

        {loadError && <div style={consoleLoadMoreErrorStyle}>{loadError}</div>}

        {!loadError && orgs.length === 0 && <div style={consoleEmptyStyle}>No organizations.</div>}

        {orgs.map((o) => (
          <div key={o.orgId} style={consoleRowStyle}>
            <span style={consoleColAccountStyle}>{o.orgName}</span>
            <span style={consoleRowNumberStyle}>{o.projectCount}</span>
            <span style={consoleRowNumberStyle}>{o.workflowCount}</span>
            <span style={consoleRowRunStatusCellStyle}>
              {o.lastRun ? (
                <span style={consolePillStyle(runStatusTone(o.lastRun.status))}>{o.lastRun.status}</span>
              ) : (
                <span style={consolePillStyle('neutral')}>No runs</span>
              )}
            </span>
            <span style={consoleRowRunStartedCellStyle}>{o.lastRun ? formatDate(o.lastRun.startedAt) : '—'}</span>
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

function runStatusTone(status: string): 'ok' | 'warn' | 'bad' | 'neutral' {
  if (status === 'succeeded') return 'ok';
  if (status === 'failed') return 'bad';
  if (status === 'cancelled') return 'neutral';
  return 'warn';
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
