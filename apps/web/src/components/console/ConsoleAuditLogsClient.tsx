'use client';

import { useState, useTransition } from 'react';
import { ensureBearerToken } from '@/lib/auth/browserSession';
import type { ConsoleAuditLogFilters, ConsoleAuditLogsPage } from '@/lib/api/consoleServer';
import { loadAuditLogsAction } from '@/lib/console/actions';
import StatusPill from './StatusPill';
import {
  consoleColAccountStyle,
  consoleContentStyle,
  consoleEmptyStyle,
  consoleGhostBtnStyle,
  consoleHeaderRowStyle,
  consoleHeaderSubStyle,
  consoleHeaderTitleColStyle,
  consoleHeaderTitleStyle,
  consoleLoadMoreRowStyle,
  consoleRowStyle,
  consoleTableHeadRowStyle,
  consoleTableStyle,
} from './styles';
import {
  consoleUsageFilterActionsStyle,
  consoleUsageFilterBarStyle,
  consoleUsageFilterErrorStyle,
  consoleUsageFilterFieldStyle,
  consoleUsageFilterInputStyle,
  consoleUsageFilterLabelStyle,
} from './usageStyles';

type FilterForm = {
  dateFrom: string;
  dateTo: string;
  orgId: string;
  staffUserId: string;
  action: string;
};

const EMPTY_FORM: FilterForm = { dateFrom: '', dateTo: '', orgId: '', staffUserId: '', action: '' };

/** Local <input type="date"> value ('YYYY-MM-DD') -> the ISO datetime-with-offset string the API's z.string().datetime({ offset: true }) requires. */
function dateInputToIso(value: string, endOfDay: boolean): string | undefined {
  if (!value) return undefined;
  const d = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  return d.toISOString();
}

function formToFilters(form: FilterForm): ConsoleAuditLogFilters {
  return {
    dateFrom: dateInputToIso(form.dateFrom, false),
    dateTo: dateInputToIso(form.dateTo, true),
    orgId: form.orgId.trim() || undefined,
    staffUserId: form.staffUserId.trim() || undefined,
    action: form.action.trim() || undefined,
  };
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Console redesign plan's Slice 8 — Audit Logs page. Lists the unioned
 * staff_audit_log/audit_log feed (apps/api/src/routes/consoleAuditLogs.ts),
 * filterable by date range/org/staff member/action, with the same
 * "Apply"/"Reset" filter-bar pattern as ConsoleUsageClient and the same
 * "Load more" pagination pattern as ConsoleProjectsClient/ConsoleStaffClient.
 * CSV export reuses ConsoleUsageClient's bearer-token-fetch-blob pattern
 * since this is a GET with Content-Disposition: attachment, not something a
 * Server Action can stream to the browser.
 */
export default function ConsoleAuditLogsClient({ initialPage }: { initialPage: ConsoleAuditLogsPage }) {
  const [form, setForm] = useState<FilterForm>(EMPTY_FORM);
  const [items, setItems] = useState(initialPage.items);
  const [offset, setOffset] = useState(initialPage.offset + initialPage.items.length);
  const [total, setTotal] = useState(initialPage.total);
  const [hasMore, setHasMore] = useState(initialPage.hasMore);
  const [error, setError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isExporting, setIsExporting] = useState(false);

  function reload(nextForm: FilterForm) {
    setError(null);
    startTransition(async () => {
      try {
        const page = await loadAuditLogsAction(formToFilters(nextForm));
        setItems(page.items);
        setOffset(page.offset + page.items.length);
        setTotal(page.total);
        setHasMore(page.hasMore);
      } catch {
        setError("Couldn't load audit logs. Try again.");
      }
    });
  }

  function handleApply() {
    reload(form);
  }

  function handleReset() {
    setForm(EMPTY_FORM);
    reload(EMPTY_FORM);
  }

  function handleLoadMore() {
    setError(null);
    startTransition(async () => {
      try {
        const page = await loadAuditLogsAction(formToFilters(form), offset);
        setItems((prev) => [...prev, ...page.items]);
        setOffset(page.offset + page.items.length);
        setTotal(page.total);
        setHasMore(page.hasMore);
      } catch {
        setError("Couldn't load more audit logs. Try again.");
      }
    });
  }

  async function handleExport() {
    setExportError(null);
    setIsExporting(true);
    try {
      const token = await ensureBearerToken();
      if (!token) {
        setExportError('Your session expired. Reload and sign in again.');
        return;
      }
      const filters = formToFilters(form);
      const query = new URLSearchParams();
      if (filters.dateFrom) query.set('dateFrom', filters.dateFrom);
      if (filters.dateTo) query.set('dateTo', filters.dateTo);
      if (filters.orgId) query.set('orgId', filters.orgId);
      if (filters.staffUserId) query.set('staffUserId', filters.staffUserId);
      if (filters.action) query.set('action', filters.action);

      const res = await fetch(`/api/backend/console/audit-logs/export?${query.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setExportError("Couldn't export audit logs. Try again.");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'audit-logs.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setExportError("Couldn't export audit logs. Try again.");
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div style={consoleContentStyle}>
      <div style={consoleHeaderRowStyle}>
        <div style={consoleHeaderTitleColStyle}>
          <span style={consoleHeaderTitleStyle}>Audit Logs</span>
          <span style={consoleHeaderSubStyle}>
            Showing {items.length} of {total}
          </span>
        </div>
        <button type="button" style={consoleGhostBtnStyle} onClick={handleExport} disabled={isExporting}>
          {isExporting ? 'Exporting…' : 'Export CSV'}
        </button>
      </div>
      {exportError && <span style={consoleUsageFilterErrorStyle}>{exportError}</span>}

      <div style={consoleUsageFilterBarStyle}>
        <div style={consoleUsageFilterFieldStyle}>
          <label style={consoleUsageFilterLabelStyle} htmlFor="audit-date-from">
            From
          </label>
          <input
            id="audit-date-from"
            type="date"
            style={consoleUsageFilterInputStyle}
            value={form.dateFrom}
            onChange={(e) => setForm((f) => ({ ...f, dateFrom: e.target.value }))}
          />
        </div>
        <div style={consoleUsageFilterFieldStyle}>
          <label style={consoleUsageFilterLabelStyle} htmlFor="audit-date-to">
            To
          </label>
          <input
            id="audit-date-to"
            type="date"
            style={consoleUsageFilterInputStyle}
            value={form.dateTo}
            onChange={(e) => setForm((f) => ({ ...f, dateTo: e.target.value }))}
          />
        </div>
        <div style={consoleUsageFilterFieldStyle}>
          <label style={consoleUsageFilterLabelStyle} htmlFor="audit-org-id">
            Org ID
          </label>
          <input
            id="audit-org-id"
            type="text"
            style={consoleUsageFilterInputStyle}
            value={form.orgId}
            onChange={(e) => setForm((f) => ({ ...f, orgId: e.target.value }))}
          />
        </div>
        <div style={consoleUsageFilterFieldStyle}>
          <label style={consoleUsageFilterLabelStyle} htmlFor="audit-staff-user-id">
            Staff user ID
          </label>
          <input
            id="audit-staff-user-id"
            type="text"
            style={consoleUsageFilterInputStyle}
            value={form.staffUserId}
            onChange={(e) => setForm((f) => ({ ...f, staffUserId: e.target.value }))}
          />
        </div>
        <div style={consoleUsageFilterFieldStyle}>
          <label style={consoleUsageFilterLabelStyle} htmlFor="audit-action">
            Action
          </label>
          <input
            id="audit-action"
            type="text"
            placeholder="e.g. suspend"
            style={consoleUsageFilterInputStyle}
            value={form.action}
            onChange={(e) => setForm((f) => ({ ...f, action: e.target.value }))}
          />
        </div>
        <div style={consoleUsageFilterActionsStyle}>
          <button type="button" style={consoleGhostBtnStyle} onClick={handleReset} disabled={isPending}>
            Reset
          </button>
          <button type="button" style={consoleGhostBtnStyle} onClick={handleApply} disabled={isPending}>
            {isPending ? 'Loading…' : 'Apply'}
          </button>
        </div>
      </div>
      {error && <span style={consoleUsageFilterErrorStyle}>{error}</span>}

      <div style={consoleTableStyle}>
        <div style={consoleTableHeadRowStyle}>
          <span style={{ flex: '0 1 70px', minWidth: 60 }}>Source</span>
          <span style={{ flex: '0 1 150px', minWidth: 130 }}>Time</span>
          <span style={consoleColAccountStyle}>Action</span>
          <span style={consoleColAccountStyle}>Actor</span>
          <span style={consoleColAccountStyle}>Org</span>
        </div>

        {!error && items.length === 0 && <div style={consoleEmptyStyle}>No audit log entries.</div>}

        {items.map((item) => (
          <div key={`${item.source}-${item.id}`} style={consoleRowStyle}>
            <span style={{ flex: '0 1 70px', minWidth: 60 }}>
              <StatusPill tone={item.source === 'staff' ? 'warning' : 'neutral'} label={item.source} />
            </span>
            <span style={{ flex: '0 1 150px', minWidth: 130 }}>{formatDateTime(item.createdAt)}</span>
            <span style={consoleColAccountStyle}>{item.action}</span>
            <span style={consoleColAccountStyle}>{item.actorName ?? '—'}</span>
            <span style={consoleColAccountStyle}>{item.orgName ?? '—'}</span>
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
