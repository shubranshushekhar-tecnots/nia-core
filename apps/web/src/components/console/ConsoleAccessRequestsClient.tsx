'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import type { ConsoleAccessRequestsPage, ConsolePlan } from '@/lib/api/consoleServer';
import { approveAccessRequestAction, loadAccessRequestsAction, rejectAccessRequestAction } from '@/lib/console/actions';
import AccessRequestApproveForm from './AccessRequestApproveForm';
import StatusPill, { type StatusTone } from './StatusPill';
import {
  consoleColActionsStyle,
  consoleColJoinedStyle,
  consoleColStatusStyle,
  consoleContentStyle,
  consoleDangerBtnStyle,
  consoleEmptyStyle,
  consoleGhostBtnStyle,
  consoleHeaderRowStyle,
  consoleHeaderSubStyle,
  consoleHeaderTitleColStyle,
  consoleHeaderTitleStyle,
  consoleLoadMoreErrorStyle,
  consoleLoadMoreRowStyle,
  consolePlanFieldLabelStyle,
  consolePlanFieldStyle,
  consolePlanFormActionsStyle,
  consolePlanFormErrorStyle,
  consolePrimaryBtnStyle,
  consoleRowJoinedCellStyle,
  consoleRowNameColStyle,
  consoleRowNameStyle,
  consoleRowKindStyle,
  consoleRowStyle,
  consoleRunsCaptionStyle,
  consoleSearchStyle,
  consoleSuspendFormStyle,
  consoleSuspendTextareaStyle,
  consoleTableHeadRowStyle,
  consoleTableStyle,
  consoleTabsRowStyle,
  consoleTabStyle,
  consoleToolbarRowStyle,
} from './styles';

type Tab = 'pending' | 'approved' | 'rejected';

const STATUS_TONE: Record<Tab, StatusTone> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'error',
};

const colAccountStyle = { flex: '2 1 220px', minWidth: 170 } as const;
const colCompanyStyle = { flex: '1 1 150px', minWidth: 110 } as const;
const colUseCaseStyle = { flex: '2 1 220px', minWidth: 150 } as const;
const colActionsWideStyle = { flex: '0 0 200px', textAlign: 'right' as const };

/**
 * Email Phase 3 — Console "Access requests" screen (review queue for the
 * public /request-access form). Same debounced-search + status-tab +
 * "Load more" list pattern as ConsoleUsersClient/ConsoleAnnouncementsClient.
 * Approve/reject expand inline per-row (same "expand in place, not a
 * modal" convention as ConsoleOrgDetailClient's suspend form) — only
 * pending rows show action buttons; approved/rejected rows are read-only
 * history (re-approving a rejected row isn't exposed in this UI, though
 * the API supports it).
 */
export default function ConsoleAccessRequestsClient({
  initialPage,
  plans,
}: {
  initialPage: ConsoleAccessRequestsPage;
  plans: ConsolePlan[];
}) {
  const [activeTab, setActiveTab] = useState<Tab>('pending');
  const [page, setPage] = useState(initialPage);
  const [query, setQuery] = useState('');
  const [listError, setListError] = useState<string | null>(null);
  const [isListPending, startListTransition] = useTransition();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reviewMode, setReviewMode] = useState<'approve' | 'reject' | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rowError, setRowError] = useState<string | null>(null);
  const [isRowPending, startRowTransition] = useTransition();

  function reload(tab: Tab, search: string) {
    setListError(null);
    startListTransition(async () => {
      try {
        const next = await loadAccessRequestsAction(tab, search, 0);
        setPage(next);
      } catch {
        setListError("Couldn't load access requests. Try again.");
      }
    });
  }

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => reload(activeTab, query.trim()), 300);
    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, activeTab]);

  function switchTab(tab: Tab) {
    setActiveTab(tab);
    setExpandedId(null);
    reload(tab, query.trim());
  }

  function loadMore() {
    setListError(null);
    startListTransition(async () => {
      try {
        const next = await loadAccessRequestsAction(activeTab, query.trim(), page.offset + page.items.length);
        setPage((prev) => ({ ...next, items: [...prev.items, ...next.items] }));
      } catch {
        setListError("Couldn't load more access requests. Try again.");
      }
    });
  }

  function startReview(id: string, mode: 'approve' | 'reject') {
    setExpandedId(id);
    setReviewMode(mode);
    setRejectReason('');
    setRowError(null);
  }

  function closeReview() {
    setExpandedId(null);
    setReviewMode(null);
    setRowError(null);
  }

  function handleApprove(values: { planId?: string; grantPlanId: string | null; grantExpiresAt: string | null }) {
    if (!expandedId) return;
    setRowError(null);
    startRowTransition(async () => {
      const result = await approveAccessRequestAction(expandedId, values.planId, values.grantPlanId, values.grantExpiresAt);
      if (!result.ok) {
        setRowError(result.error);
        return;
      }
      setPage((prev) => ({ ...prev, items: prev.items.filter((r) => r.id !== expandedId) }));
      closeReview();
    });
  }

  function handleReject() {
    if (!expandedId) return;
    setRowError(null);
    startRowTransition(async () => {
      const result = await rejectAccessRequestAction(expandedId, rejectReason.trim());
      if (!result.ok) {
        setRowError(result.error);
        return;
      }
      setPage((prev) => ({ ...prev, items: prev.items.filter((r) => r.id !== expandedId) }));
      closeReview();
    });
  }

  function planName(id: string | null): string {
    if (!id) return '—';
    return plans.find((p) => p.id === id)?.name ?? id;
  }

  return (
    <div style={consoleContentStyle}>
      <div style={consoleHeaderRowStyle}>
        <div style={consoleHeaderTitleColStyle}>
          <span style={consoleHeaderTitleStyle}>Access Requests</span>
          <span style={consoleHeaderSubStyle}>
            Showing {page.items.length} of {page.total} {activeTab} requests
          </span>
        </div>
      </div>

      <div style={consoleTabsRowStyle}>
        <button type="button" onClick={() => switchTab('pending')} style={consoleTabStyle(activeTab === 'pending')}>
          Pending
        </button>
        <button type="button" onClick={() => switchTab('approved')} style={consoleTabStyle(activeTab === 'approved')}>
          Approved
        </button>
        <button type="button" onClick={() => switchTab('rejected')} style={consoleTabStyle(activeTab === 'rejected')}>
          Rejected
        </button>
      </div>

      <div style={consoleToolbarRowStyle}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, email, or company"
          spellCheck={false}
          style={consoleSearchStyle}
        />
      </div>

      <div style={consoleTableStyle}>
        <div style={consoleTableHeadRowStyle}>
          <span style={colAccountStyle}>Requester</span>
          <span style={colCompanyStyle}>Company</span>
          <span style={colUseCaseStyle}>Use case</span>
          <span style={consoleColStatusStyle}>Status</span>
          <span style={consoleColJoinedStyle}>Requested</span>
          {activeTab === 'pending' && <span style={colActionsWideStyle}>Actions</span>}
        </div>

        {listError && <div style={consoleLoadMoreErrorStyle}>{listError}</div>}

        {!listError && page.items.length === 0 && (
          <div style={consoleEmptyStyle}>{query ? `No ${activeTab} requests match "${query}".` : `No ${activeTab} requests.`}</div>
        )}

        {page.items.map((r) => (
          <div key={r.id}>
            <div style={consoleRowStyle}>
              <span style={colAccountStyle}>
                <span style={consoleRowNameColStyle}>
                  <span style={consoleRowNameStyle}>{r.fullName}</span>
                  <span style={consoleRowKindStyle}>{r.email}</span>
                </span>
              </span>
              <span style={colCompanyStyle}>{r.company}</span>
              <span style={colUseCaseStyle}>{r.useCase}</span>
              <span style={consoleColStatusStyle}>
                <StatusPill tone={STATUS_TONE[r.status]} label={r.status.charAt(0).toUpperCase() + r.status.slice(1)} />
              </span>
              <span style={consoleRowJoinedCellStyle}>{formatDate(r.createdAt)}</span>
              {activeTab === 'pending' && (
                <span style={colActionsWideStyle}>
                  {expandedId !== r.id && (
                    <>
                      <button type="button" onClick={() => startReview(r.id, 'approve')} style={consolePrimaryBtnStyle}>
                        Approve
                      </button>{' '}
                      <button type="button" onClick={() => startReview(r.id, 'reject')} style={consoleDangerBtnStyle}>
                        Reject
                      </button>
                    </>
                  )}
                </span>
              )}
            </div>

            {expandedId === r.id && reviewMode === 'approve' && (
              <AccessRequestApproveForm
                plans={plans}
                isPending={isRowPending}
                error={rowError}
                onApprove={handleApprove}
                onCancel={closeReview}
              />
            )}

            {expandedId === r.id && reviewMode === 'reject' && (
              <div style={consoleSuspendFormStyle}>
                <div style={consolePlanFieldStyle}>
                  <label htmlFor={`console-access-request-reject-reason-${r.id}`} style={consolePlanFieldLabelStyle}>
                    Reason (optional, included in the rejection email)
                  </label>
                  <textarea
                    id={`console-access-request-reject-reason-${r.id}`}
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    disabled={isRowPending}
                    style={consoleSuspendTextareaStyle}
                    placeholder="Why is this request being rejected?"
                  />
                </div>
                <div style={consolePlanFormActionsStyle}>
                  <button type="button" onClick={handleReject} disabled={isRowPending} style={consoleDangerBtnStyle}>
                    {isRowPending ? 'Rejecting…' : 'Confirm reject'}
                  </button>
                  <button type="button" onClick={closeReview} disabled={isRowPending} style={consoleGhostBtnStyle}>
                    Cancel
                  </button>
                </div>
                {rowError && <span style={consolePlanFormErrorStyle}>{rowError}</span>}
              </div>
            )}

            {r.status !== 'pending' && (r.reviewedAt || r.rejectedReason || r.planId) && (
              <div style={consoleRunsCaptionStyle}>
                {r.status === 'approved'
                  ? `Approved${r.reviewedAt ? ` ${formatDate(r.reviewedAt)}` : ''}${r.planId ? ` · plan: ${planName(r.planId)}` : ''}`
                  : `Rejected${r.reviewedAt ? ` ${formatDate(r.reviewedAt)}` : ''}${r.rejectedReason ? ` · ${r.rejectedReason}` : ''}`}
              </div>
            )}
          </div>
        ))}
      </div>

      {page.hasMore && (
        <div style={consoleLoadMoreRowStyle}>
          <button type="button" onClick={loadMore} disabled={isListPending} style={consoleGhostBtnStyle}>
            {isListPending ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
