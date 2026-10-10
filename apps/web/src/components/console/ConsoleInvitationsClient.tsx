'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import type { ConsolePlan, ConsolePlatformInvitesPage } from '@/lib/api/consoleServer';
import {
  createPlatformInviteAction,
  loadPlatformInvitesAction,
  resendPlatformInviteAction,
  revokePlatformInviteAction,
} from '@/lib/console/actions';
import StatusPill, { type StatusTone } from './StatusPill';
import {
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
  consolePlanFormStyle,
  consolePlanInputStyle,
  consolePrimaryBtnStyle,
  consoleRowJoinedCellStyle,
  consoleRowKindStyle,
  consoleRowNameColStyle,
  consoleRowNameStyle,
  consoleRowStyle,
  consoleRunsCaptionStyle,
  consoleSearchStyle,
  consoleTableHeadRowStyle,
  consoleTableStyle,
  consoleTabsRowStyle,
  consoleTabStyle,
  consoleToolbarRowStyle,
} from './styles';

type Tab = 'pending' | 'accepted' | 'revoked';

const STATUS_TONE: Record<string, StatusTone> = {
  pending: 'warning',
  accepted: 'success',
  revoked: 'neutral',
  expired: 'error',
};

const colAccountStyle = { flex: '2 1 220px', minWidth: 170 } as const;
const colNoteStyle = { flex: '2 1 220px', minWidth: 150 } as const;
const colActionsWideStyle = { flex: '0 0 200px', textAlign: 'right' as const };

/**
 * Email Phase 3 — Console "Invitations" screen (direct staff-initiated
 * platform invites, distinct from org-scoped invite_links). Same
 * debounced-search + status-tab + "Load more" list pattern as
 * ConsoleAccessRequestsClient. Adds a small inline "Invite" create form
 * above the table (same "expand in place, not a modal" convention) and
 * per-row Resend/Revoke actions on pending invites.
 */
export default function ConsoleInvitationsClient({
  initialPage,
  plans,
}: {
  initialPage: ConsolePlatformInvitesPage;
  plans: ConsolePlan[];
}) {
  const [activeTab, setActiveTab] = useState<Tab>('pending');
  const [page, setPage] = useState(initialPage);
  const [query, setQuery] = useState('');
  const [listError, setListError] = useState<string | null>(null);
  const [isListPending, startListTransition] = useTransition();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [showCreate, setShowCreate] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [planId, setPlanId] = useState('');
  const [grantPlanId, setGrantPlanId] = useState('');
  const [grantExpiresAt, setGrantExpiresAt] = useState('');
  const [note, setNote] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreatePending, startCreateTransition] = useTransition();

  const [rowPendingId, setRowPendingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [isRowPending, startRowTransition] = useTransition();

  function reload(tab: Tab, search: string) {
    setListError(null);
    startListTransition(async () => {
      try {
        const next = await loadPlatformInvitesAction(tab, search, 0);
        setPage(next);
      } catch {
        setListError("Couldn't load invitations. Try again.");
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
    reload(tab, query.trim());
  }

  function loadMore() {
    setListError(null);
    startListTransition(async () => {
      try {
        const next = await loadPlatformInvitesAction(activeTab, query.trim(), page.offset + page.items.length);
        setPage((prev) => ({ ...next, items: [...prev.items, ...next.items] }));
      } catch {
        setListError("Couldn't load more invitations. Try again.");
      }
    });
  }

  function resetCreateForm() {
    setEmail('');
    setName('');
    setPlanId('');
    setGrantPlanId('');
    setGrantExpiresAt('');
    setNote('');
    setCreateError(null);
  }

  function handleCreate() {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setCreateError('Email is required.');
      return;
    }
    setCreateError(null);
    startCreateTransition(async () => {
      const result = await createPlatformInviteAction({
        email: trimmedEmail,
        name: name.trim() || undefined,
        planId: planId || undefined,
        grantPlanId: grantPlanId || undefined,
        grantExpiresAt: grantExpiresAt ? new Date(`${grantExpiresAt}T00:00:00.000Z`).toISOString() : undefined,
        note: note.trim() || undefined,
      });
      if (!result.ok) {
        setCreateError(result.error);
        return;
      }
      resetCreateForm();
      setShowCreate(false);
      if (activeTab === 'pending') {
        setPage((prev) => ({ ...prev, items: [result.invite, ...prev.items], total: prev.total + 1 }));
      }
    });
  }

  function handleResend(id: string) {
    setRowError(null);
    setRowPendingId(id);
    startRowTransition(async () => {
      const result = await resendPlatformInviteAction(id);
      setRowPendingId(null);
      if (!result.ok) {
        setRowError(result.error);
        return;
      }
      setPage((prev) => ({ ...prev, items: prev.items.map((inv) => (inv.id === id ? result.invite : inv)) }));
    });
  }

  function handleRevoke(id: string) {
    setRowError(null);
    setRowPendingId(id);
    startRowTransition(async () => {
      const result = await revokePlatformInviteAction(id);
      setRowPendingId(null);
      if (!result.ok) {
        setRowError(result.error);
        return;
      }
      if (activeTab === 'pending') {
        setPage((prev) => ({ ...prev, items: prev.items.filter((inv) => inv.id !== id) }));
      } else {
        setPage((prev) => ({ ...prev, items: prev.items.map((inv) => (inv.id === id ? result.invite : inv)) }));
      }
    });
  }

  return (
    <div style={consoleContentStyle}>
      <div style={consoleHeaderRowStyle}>
        <div style={consoleHeaderTitleColStyle}>
          <span style={consoleHeaderTitleStyle}>Invitations</span>
          <span style={consoleHeaderSubStyle}>
            Showing {page.items.length} of {page.total} {activeTab} invites
          </span>
        </div>
        {!showCreate && (
          <button type="button" onClick={() => setShowCreate(true)} style={consolePrimaryBtnStyle}>
            Invite
          </button>
        )}
      </div>

      {showCreate && (
        <div style={consolePlanFormStyle}>
          <div style={consolePlanFieldStyle}>
            <label htmlFor="console-invite-email" style={consolePlanFieldLabelStyle}>
              Email
            </label>
            <input
              id="console-invite-email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={isCreatePending}
              style={consolePlanInputStyle}
              placeholder="person@company.com"
            />
          </div>
          <div style={consolePlanFieldStyle}>
            <label htmlFor="console-invite-name" style={consolePlanFieldLabelStyle}>
              Name (optional)
            </label>
            <input
              id="console-invite-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isCreatePending}
              style={consolePlanInputStyle}
            />
          </div>
          <div style={consolePlanFieldStyle}>
            <label htmlFor="console-invite-plan" style={consolePlanFieldLabelStyle}>
              Plan (optional)
            </label>
            <select
              id="console-invite-plan"
              value={planId}
              onChange={(e) => setPlanId(e.target.value)}
              disabled={isCreatePending}
              style={consolePlanInputStyle}
            >
              <option value="">Default plan</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div style={consolePlanFieldStyle}>
            <label htmlFor="console-invite-grant-plan" style={consolePlanFieldLabelStyle}>
              Grant plan (optional, temporary)
            </label>
            <select
              id="console-invite-grant-plan"
              value={grantPlanId}
              onChange={(e) => setGrantPlanId(e.target.value)}
              disabled={isCreatePending}
              style={consolePlanInputStyle}
            >
              <option value="">None</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div style={consolePlanFieldStyle}>
            <label htmlFor="console-invite-grant-expires" style={consolePlanFieldLabelStyle}>
              Grant expiry (optional)
            </label>
            <input
              id="console-invite-grant-expires"
              type="date"
              value={grantExpiresAt}
              onChange={(e) => setGrantExpiresAt(e.target.value)}
              disabled={isCreatePending}
              style={consolePlanInputStyle}
            />
          </div>
          <div style={{ ...consolePlanFieldStyle, flex: '1 1 100%' }}>
            <label htmlFor="console-invite-note" style={consolePlanFieldLabelStyle}>
              Note (optional, internal)
            </label>
            <input
              id="console-invite-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={isCreatePending}
              style={{ ...consolePlanInputStyle, width: '100%' }}
            />
          </div>
          <div style={consolePlanFormActionsStyle}>
            <button type="button" onClick={handleCreate} disabled={isCreatePending} style={consolePrimaryBtnStyle}>
              {isCreatePending ? 'Sending…' : 'Send invite'}
            </button>
            <button
              type="button"
              onClick={() => {
                resetCreateForm();
                setShowCreate(false);
              }}
              disabled={isCreatePending}
              style={consoleGhostBtnStyle}
            >
              Cancel
            </button>
          </div>
          {createError && <span style={consolePlanFormErrorStyle}>{createError}</span>}
        </div>
      )}

      <div style={consoleTabsRowStyle}>
        <button type="button" onClick={() => switchTab('pending')} style={consoleTabStyle(activeTab === 'pending')}>
          Pending
        </button>
        <button type="button" onClick={() => switchTab('accepted')} style={consoleTabStyle(activeTab === 'accepted')}>
          Accepted
        </button>
        <button type="button" onClick={() => switchTab('revoked')} style={consoleTabStyle(activeTab === 'revoked')}>
          Revoked
        </button>
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

      {rowError && <div style={consoleLoadMoreErrorStyle}>{rowError}</div>}

      <div style={consoleTableStyle}>
        <div style={consoleTableHeadRowStyle}>
          <span style={colAccountStyle}>Invitee</span>
          <span style={colNoteStyle}>Note</span>
          <span style={consoleColStatusStyle}>Status</span>
          <span style={consoleColJoinedStyle}>Created</span>
          {activeTab === 'pending' && <span style={colActionsWideStyle}>Actions</span>}
        </div>

        {listError && <div style={consoleLoadMoreErrorStyle}>{listError}</div>}

        {!listError && page.items.length === 0 && (
          <div style={consoleEmptyStyle}>{query ? `No ${activeTab} invites match "${query}".` : `No ${activeTab} invites.`}</div>
        )}

        {page.items.map((inv) => {
          const statusLabel = inv.expired ? 'Expired' : inv.status.charAt(0).toUpperCase() + inv.status.slice(1);
          const tone = STATUS_TONE[inv.expired ? 'expired' : inv.status] ?? 'neutral';
          return (
            <div key={inv.id}>
              <div style={consoleRowStyle}>
                <span style={colAccountStyle}>
                  <span style={consoleRowNameColStyle}>
                    <span style={consoleRowNameStyle}>{inv.name || inv.email}</span>
                    <span style={consoleRowKindStyle}>{inv.email}</span>
                  </span>
                </span>
                <span style={colNoteStyle}>{inv.note || '—'}</span>
                <span style={consoleColStatusStyle}>
                  <StatusPill tone={tone} label={statusLabel} />
                </span>
                <span style={consoleRowJoinedCellStyle}>{formatDate(inv.createdAt)}</span>
                {activeTab === 'pending' && (
                  <span style={colActionsWideStyle}>
                    <button
                      type="button"
                      onClick={() => handleResend(inv.id)}
                      disabled={isRowPending && rowPendingId === inv.id}
                      style={consoleGhostBtnStyle}
                    >
                      {isRowPending && rowPendingId === inv.id ? 'Working…' : 'Resend'}
                    </button>{' '}
                    <button
                      type="button"
                      onClick={() => handleRevoke(inv.id)}
                      disabled={isRowPending && rowPendingId === inv.id}
                      style={consoleDangerBtnStyle}
                    >
                      Revoke
                    </button>
                  </span>
                )}
              </div>
              {inv.status === 'accepted' && inv.acceptedAt && (
                <div style={consoleRunsCaptionStyle}>Accepted {formatDate(inv.acceptedAt)}</div>
              )}
            </div>
          );
        })}
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
