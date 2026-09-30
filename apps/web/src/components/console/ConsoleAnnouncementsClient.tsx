'use client';

import { useState, useTransition } from 'react';
import type { ConsoleAnnouncement, ConsoleAnnouncementsPage } from '@/lib/api/consoleServer';
import {
  archiveAnnouncementAction,
  createAnnouncementAction,
  endAnnouncementAction,
  loadAnnouncementsAction,
} from '@/lib/console/actions';
import {
  consoleAnnouncementFieldsRowStyle,
  consoleAnnouncementFormStyle,
  consoleAnnouncementInputStyle,
  consoleAnnouncementListStyle,
  consoleAnnouncementPreviewBodyStyle,
  consoleAnnouncementPreviewStyle,
  consoleAnnouncementPreviewTitleStyle,
  consoleAnnouncementPreviewWrapStyle,
  consoleAnnouncementRoleLabelStyle,
  consoleAnnouncementRolesRowStyle,
  consoleAnnouncementRowBodyStyle,
  consoleAnnouncementRowHeaderStyle,
  consoleAnnouncementRowMetaStyle,
  consoleAnnouncementRowStyle,
  consoleAnnouncementRowTitleGroupStyle,
  consoleAnnouncementRowTitleStyle,
  consoleContentStyle,
  consoleDangerBtnStyle,
  consoleEmptyStyle,
  consoleGhostBtnStyle,
  consoleHeaderActionsStyle,
  consoleHeaderRowStyle,
  consoleHeaderSubStyle,
  consoleHeaderTitleStyle,
  consoleLoadMoreErrorStyle,
  consoleLoadMoreRowStyle,
  consolePillStyle,
  consolePlanFieldLabelStyle,
  consolePlanFieldStyle,
  consolePlanFormActionsStyle,
  consolePlanFormErrorStyle,
  consolePrimaryBtnStyle,
  consoleSuspendTextareaStyle,
  consoleTabsRowStyle,
  consoleTabStyle,
} from './styles';

type Tab = 'active' | 'scheduled' | 'ended';
type Severity = 'info' | 'warning' | 'critical';
type Audience = 'all' | 'org' | 'project';
type OrgRole = 'member' | 'admin' | 'owner' | 'viewer';

const SEVERITY_TONE: Record<Severity, 'neutral' | 'warn' | 'bad'> = {
  info: 'neutral',
  warning: 'warn',
  critical: 'bad',
};

const ROLE_OPTIONS: OrgRole[] = ['owner', 'admin', 'member', 'viewer'];

/**
 * Subscription Phase 5, Slice 3 (docs/plans/subscription-model.md, decision
 * 1). Reached via ConsoleShell's 'notify' nav entry. Three-tab list
 * (active/scheduled/ended — mirrors the API's computed `status`) plus an
 * inline create form with a live preview (spec: "create with a live
 * preview before publishing"), same inline-form-not-modal convention as
 * every other Console screen (see ConsoleOrgDetailClient's own doc
 * comment). End/archive have no reason field (unlike suspend/revoke): a
 * staff member ending their own announcement isn't a customer-facing
 * destructive action requiring justification.
 */
export default function ConsoleAnnouncementsClient({ initialPage }: { initialPage: ConsoleAnnouncementsPage }) {
  const [activeTab, setActiveTab] = useState<Tab>('active');
  const [page, setPage] = useState(initialPage);
  const [listError, setListError] = useState<string | null>(null);
  const [isListPending, startListTransition] = useTransition();

  const [createMode, setCreateMode] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<Severity>('info');
  const [audience, setAudience] = useState<Audience>('all');
  const [audienceOrgId, setAudienceOrgId] = useState('');
  const [audienceProjectId, setAudienceProjectId] = useState('');
  const [audienceRoles, setAudienceRoles] = useState<OrgRole[]>([]);
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreatePending, startCreateTransition] = useTransition();

  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [pendingRowId, setPendingRowId] = useState<string | null>(null);
  const [isRowPending, startRowTransition] = useTransition();

  function switchTab(tab: Tab) {
    setActiveTab(tab);
    setListError(null);
    startListTransition(async () => {
      try {
        const next = await loadAnnouncementsAction(tab, 0);
        setPage(next);
      } catch {
        setListError("Couldn't load announcements. Try again.");
      }
    });
  }

  function loadMore() {
    setListError(null);
    startListTransition(async () => {
      try {
        const next = await loadAnnouncementsAction(activeTab, page.offset + page.announcements.length);
        setPage((prev) => ({ ...next, announcements: [...prev.announcements, ...next.announcements] }));
      } catch {
        setListError("Couldn't load more announcements. Try again.");
      }
    });
  }

  function resetForm() {
    setTitle('');
    setBody('');
    setSeverity('info');
    setAudience('all');
    setAudienceOrgId('');
    setAudienceProjectId('');
    setAudienceRoles([]);
    setStartsAt('');
    setEndsAt('');
    setCreateError(null);
  }

  function startCreating() {
    resetForm();
    setCreateMode(true);
  }

  function toggleRole(role: OrgRole) {
    setAudienceRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));
  }

  function handleCreate() {
    const trimmedTitle = title.trim();
    const trimmedBody = body.trim();
    if (!trimmedTitle) {
      setCreateError('Title is required.');
      return;
    }
    if (!trimmedBody) {
      setCreateError('Body is required.');
      return;
    }
    if (audience === 'org' && !audienceOrgId.trim()) {
      setCreateError('Org ID is required for org audience.');
      return;
    }
    if (audience === 'project' && !audienceProjectId.trim()) {
      setCreateError('Project ID is required for project audience.');
      return;
    }
    if (startsAt && endsAt && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
      setCreateError('End time must be after start time.');
      return;
    }

    setCreateError(null);
    startCreateTransition(async () => {
      const result = await createAnnouncementAction({
        title: trimmedTitle,
        body: trimmedBody,
        severity,
        audience,
        audienceOrgId: audience === 'org' ? audienceOrgId.trim() : undefined,
        audienceProjectId: audience === 'project' ? audienceProjectId.trim() : undefined,
        audienceRoles: audience === 'org' && audienceRoles.length > 0 ? audienceRoles : undefined,
        startsAt: startsAt ? new Date(startsAt).toISOString() : undefined,
        endsAt: endsAt ? new Date(endsAt).toISOString() : undefined,
      });
      if (!result.ok) {
        setCreateError(result.error);
        return;
      }
      setCreateMode(false);
      resetForm();
      if (activeTab === 'active') {
        setPage((prev) => ({
          ...prev,
          announcements: [result.announcement, ...prev.announcements],
          total: prev.total + 1,
        }));
      }
    });
  }

  function handleEnd(id: string) {
    setRowError((prev) => ({ ...prev, [id]: '' }));
    setPendingRowId(id);
    startRowTransition(async () => {
      const result = await endAnnouncementAction(id);
      if (!result.ok) {
        setRowError((prev) => ({ ...prev, [id]: result.error }));
        setPendingRowId(null);
        return;
      }
      setPage((prev) => ({ ...prev, announcements: prev.announcements.filter((a) => a.id !== id) }));
      setPendingRowId(null);
    });
  }

  function handleArchive(id: string) {
    setRowError((prev) => ({ ...prev, [id]: '' }));
    setPendingRowId(id);
    startRowTransition(async () => {
      const result = await archiveAnnouncementAction(id);
      if (!result.ok) {
        setRowError((prev) => ({ ...prev, [id]: result.error }));
        setPendingRowId(null);
        return;
      }
      setPage((prev) => ({ ...prev, announcements: prev.announcements.filter((a) => a.id !== id) }));
      setPendingRowId(null);
    });
  }

  return (
    <div style={consoleContentStyle}>
      <div style={consoleHeaderRowStyle}>
        <div>
          <span style={consoleHeaderTitleStyle}>Announcements</span>
          <div style={consoleHeaderSubStyle}>In-app banners shown to customers in the app shell.</div>
        </div>
        {!createMode && (
          <div style={consoleHeaderActionsStyle}>
            <button type="button" onClick={startCreating} style={consolePrimaryBtnStyle}>
              New announcement
            </button>
          </div>
        )}
      </div>

      {createMode && (
        <div style={consoleAnnouncementFormStyle}>
          <div style={consolePlanFieldStyle}>
            <label htmlFor="ann-title" style={consolePlanFieldLabelStyle}>
              Title
            </label>
            <input
              id="ann-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={isCreatePending}
              style={consoleAnnouncementInputStyle}
              placeholder="Scheduled maintenance"
            />
          </div>

          <div style={consolePlanFieldStyle}>
            <label htmlFor="ann-body" style={consolePlanFieldLabelStyle}>
              Body
            </label>
            <textarea
              id="ann-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={isCreatePending}
              style={consoleSuspendTextareaStyle}
              placeholder="Plain text only — rendered as-is, never as HTML."
            />
          </div>

          <div style={consoleAnnouncementFieldsRowStyle}>
            <div style={consolePlanFieldStyle}>
              <label htmlFor="ann-severity" style={consolePlanFieldLabelStyle}>
                Severity
              </label>
              <select
                id="ann-severity"
                value={severity}
                onChange={(e) => setSeverity(e.target.value as Severity)}
                disabled={isCreatePending}
                style={consoleAnnouncementInputStyle}
              >
                <option value="info">Info</option>
                <option value="warning">Warning</option>
                <option value="critical">Critical</option>
              </select>
            </div>

            <div style={consolePlanFieldStyle}>
              <label htmlFor="ann-audience" style={consolePlanFieldLabelStyle}>
                Audience
              </label>
              <select
                id="ann-audience"
                value={audience}
                onChange={(e) => {
                  setAudience(e.target.value as Audience);
                  setAudienceOrgId('');
                  setAudienceProjectId('');
                  setAudienceRoles([]);
                }}
                disabled={isCreatePending}
                style={consoleAnnouncementInputStyle}
              >
                <option value="all">All users</option>
                <option value="org">One org</option>
                <option value="project">One project</option>
              </select>
            </div>

            {audience === 'org' && (
              <div style={consolePlanFieldStyle}>
                <label htmlFor="ann-org-id" style={consolePlanFieldLabelStyle}>
                  Org ID
                </label>
                <input
                  id="ann-org-id"
                  value={audienceOrgId}
                  onChange={(e) => setAudienceOrgId(e.target.value)}
                  disabled={isCreatePending}
                  style={consoleAnnouncementInputStyle}
                  placeholder="Organization UUID"
                />
              </div>
            )}

            {audience === 'project' && (
              <div style={consolePlanFieldStyle}>
                <label htmlFor="ann-project-id" style={consolePlanFieldLabelStyle}>
                  Project ID
                </label>
                <input
                  id="ann-project-id"
                  value={audienceProjectId}
                  onChange={(e) => setAudienceProjectId(e.target.value)}
                  disabled={isCreatePending}
                  style={consoleAnnouncementInputStyle}
                  placeholder="Project UUID"
                />
              </div>
            )}

            <div style={consolePlanFieldStyle}>
              <label htmlFor="ann-starts" style={consolePlanFieldLabelStyle}>
                Starts at
              </label>
              <input
                id="ann-starts"
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                disabled={isCreatePending}
                style={consoleAnnouncementInputStyle}
              />
            </div>

            <div style={consolePlanFieldStyle}>
              <label htmlFor="ann-ends" style={consolePlanFieldLabelStyle}>
                Ends at
              </label>
              <input
                id="ann-ends"
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
                disabled={isCreatePending}
                style={consoleAnnouncementInputStyle}
              />
            </div>
          </div>

          {audience === 'org' && (
            <div style={consolePlanFieldStyle}>
              <span style={consolePlanFieldLabelStyle}>Roles (optional — defaults to everyone in the org)</span>
              <div style={consoleAnnouncementRolesRowStyle}>
                {ROLE_OPTIONS.map((role) => (
                  <label key={role} style={consoleAnnouncementRoleLabelStyle}>
                    <input
                      type="checkbox"
                      checked={audienceRoles.includes(role)}
                      onChange={() => toggleRole(role)}
                      disabled={isCreatePending}
                    />
                    {role}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div style={consoleAnnouncementPreviewWrapStyle}>
            <span style={consolePlanFieldLabelStyle}>Preview</span>
            <div style={consoleAnnouncementPreviewStyle(severity)}>
              <span style={consoleAnnouncementPreviewTitleStyle}>{title || 'Announcement title'}</span>
              <span style={consoleAnnouncementPreviewBodyStyle}>{body || 'Announcement body text.'}</span>
            </div>
          </div>

          <div style={consolePlanFormActionsStyle}>
            <button type="button" onClick={handleCreate} disabled={isCreatePending} style={consolePrimaryBtnStyle}>
              {isCreatePending ? 'Publishing…' : 'Publish'}
            </button>
            <button
              type="button"
              onClick={() => setCreateMode(false)}
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
        <button type="button" onClick={() => switchTab('active')} style={consoleTabStyle(activeTab === 'active')}>
          Active
        </button>
        <button
          type="button"
          onClick={() => switchTab('scheduled')}
          style={consoleTabStyle(activeTab === 'scheduled')}
        >
          Scheduled
        </button>
        <button type="button" onClick={() => switchTab('ended')} style={consoleTabStyle(activeTab === 'ended')}>
          Ended
        </button>
      </div>

      <div style={consoleAnnouncementListStyle}>
        {page.announcements.length === 0 && !isListPending && (
          <div style={consoleEmptyStyle}>No {activeTab} announcements.</div>
        )}

        {page.announcements.map((a: ConsoleAnnouncement) => (
          <div key={a.id} style={consoleAnnouncementRowStyle}>
            <div style={consoleAnnouncementRowHeaderStyle}>
              <div style={consoleAnnouncementRowTitleGroupStyle}>
                <span style={consolePillStyle(SEVERITY_TONE[a.severity])}>{a.severity}</span>
                <span style={consoleAnnouncementRowTitleStyle}>{a.title}</span>
              </div>
              {activeTab !== 'ended' && (
                <div style={consolePlanFormActionsStyle}>
                  <button
                    type="button"
                    onClick={() => handleEnd(a.id)}
                    disabled={isRowPending && pendingRowId === a.id}
                    style={consoleGhostBtnStyle}
                  >
                    End now
                  </button>
                  <button
                    type="button"
                    onClick={() => handleArchive(a.id)}
                    disabled={isRowPending && pendingRowId === a.id}
                    style={consoleDangerBtnStyle}
                  >
                    Archive
                  </button>
                </div>
              )}
            </div>
            <span style={consoleAnnouncementRowMetaStyle}>
              {audienceLabel(a)} · {a.createdByName ?? 'Staff'} · {formatDate(a.createdAt)}
            </span>
            <span style={consoleAnnouncementRowBodyStyle}>{a.body}</span>
            {rowError[a.id] && <span style={consolePlanFormErrorStyle}>{rowError[a.id]}</span>}
          </div>
        ))}
      </div>

      {listError && <span style={consoleLoadMoreErrorStyle}>{listError}</span>}

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

function audienceLabel(a: ConsoleAnnouncement): string {
  if (a.audience === 'all') return 'All users';
  if (a.audience === 'org') return a.audienceRoles?.length ? `Org (${a.audienceRoles.join(', ')})` : 'One org';
  return 'One project';
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
