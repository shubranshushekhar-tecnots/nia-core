'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import type { ConsoleConnector, ConsoleOrgDetail, ConsoleRun } from '@/lib/api/consoleServer';
import { suspendOrgAction, unsuspendOrgAction, updateOrgPlanAction } from '@/lib/console/actions';
import { formatLowerLimitWarning } from '@/lib/console/planLimitWarning';
import {
  consoleBreadcrumbCurrentStyle,
  consoleBreadcrumbLinkStyle,
  consoleBreadcrumbRowStyle,
  consoleBreadcrumbSepStyle,
  consoleColConnectorCreatedStyle,
  consoleColConnectorHealthStyle,
  consoleColConnectorNameStyle,
  consoleColConnectorTypeStyle,
  consoleColEmailStyle,
  consoleColJoinedStyle,
  consoleColMemberStyle,
  consoleColRoleStyle,
  consoleColRunDurationStyle,
  consoleColRunErrorStyle,
  consoleColRunStartedStyle,
  consoleColRunStatusStyle,
  consoleContentStyle,
  consoleDangerBtnStyle,
  consoleDetailHeaderTitleColStyle,
  consoleEmptyStyle,
  consoleGhostBtnStyle,
  consoleHeaderActionsStyle,
  consoleHeaderRowStyle,
  consoleHeaderSubStyle,
  consoleHeaderTitleStyle,
  consoleLoadMoreErrorStyle,
  consoleMonoStyle,
  consolePillStyle,
  consolePlanFieldLabelStyle,
  consolePlanFieldStyle,
  consolePlanFormActionsStyle,
  consolePlanFormErrorStyle,
  consolePlanFormStyle,
  consolePlanFormWarningStyle,
  consolePlanInputStyle,
  consolePrimaryBtnStyle,
  consoleRowConnectorCreatedCellStyle,
  consoleRowConnectorHealthCellStyle,
  consoleRowConnectorHealthLatencyStyle,
  consoleRowConnectorNameCellStyle,
  consoleRowConnectorTypeCellStyle,
  consoleRowEmailCellStyle,
  consoleRowJoinedCellStyle,
  consoleRowLinkStyle,
  consoleRowMemberCellStyle,
  consoleRowNameColStyle,
  consoleRowNameStyle,
  consoleRowRoleCellStyle,
  consoleRowRunDurationCellStyle,
  consoleRowRunErrorCellStyle,
  consoleRowRunStartedCellStyle,
  consoleRowRunStatusCellStyle,
  consoleRowStyle,
  consoleRunsCaptionStyle,
  consoleStatCardStyle,
  consoleStatLabelStyle,
  consoleStatsRowStyle,
  consoleStatValueStyle,
  consoleSuspendedBadgeStyle,
  consoleSuspendFormStyle,
  consoleSuspendMetaStyle,
  consoleSuspendTextareaStyle,
  consoleTableHeadRowStyle,
  consoleTableStyle,
  consoleTabsRowStyle,
  consoleTabStyle,
} from './styles';

/**
 * Console v1 Org Detail screen (docs/plans/console-plan.md build order
 * steps 6-7, Slice 2). Breadcrumb, header, and Members table markup/styles
 * ported from designs/Nia Console (superadmin).html's `isOrgDetail`
 * template. Deliberately narrower than the design, following
 * ConsoleDirectoryClient's own precedent (omit controls with no real
 * capability behind them yet, rather than render them inert):
 *  - No "View as" / Delete header buttons: impersonation and delete are
 *    later build-order steps (§1's screen-mapping table), not this slice.
 *    Suspend/unsuspend (decisions 1-2, additions 3-6) IS wired below,
 *    per Slice 3b's own doc comment further down.
 *  - No Projects/Workflows/Activity tabs: only Members and Runs (Slice 3c)
 *    have real data wired up so far; a tab bar with dead tabs would be a
 *    non-functional control, exactly what ConsoleDirectoryClient's own
 *    filter-dropdown precedent already avoids.
 *  - No per-row "···" member menu: its actions (suspend/remove a member)
 *    don't exist yet either.
 *  - Members table shows "Joined" instead of the design's "Last active" /
 *    "Status" columns: no last-active tracking or member-suspension
 *    mechanism exists yet, and `joinedAt` (organization_members.created_at)
 *    is real data the API already returns.
 *
 * Plan/limits/usage (a stat-card row below the header) has no slot in the
 * design at all — the design only folds `plan` into the header's meta line
 * — but console-plan.md decision 8 requires it on this screen, so it's
 * added directly, styled consistently with the rest of Console (same
 * surface/border tokens as everywhere else) rather than left out.
 *
 * Slice 3a adds the one real write action this screen has: an "Edit plan"
 * ghost button next to the stat row toggles it into an inline form (two
 * fields, Save/Cancel) rather than a modal — consistent with the
 * minimalist convention above, and PATCH /console/orgs/:orgId/plan is a
 * two-field write, not worth a dialog. An empty "Workflow limit" field
 * submits `null` (unlimited), matching org_plan's own semantics (see
 * consoleServer.ts's ConsoleOrgDetail doc comment).
 *
 * Slice 3c adds the Members/Runs tab switcher (design's `tab(on)` helper,
 * previously unused — see styles.ts). Runs is read-only (most-recent 50,
 * metadata + error only, never result rows — see routes/console.ts's own
 * doc comment on GET /orgs/:orgId/runs) and is fetched eagerly alongside
 * org detail in page.tsx rather than on tab-click, so switching tabs is
 * instant and never shows a loading state.
 *
 * Slice 3d adds a third Connectors tab, same eager-fetch/no-loading-state
 * pattern as Runs — connector type, display name, last-test health, and
 * created date only, never config/vault_secret_ref (see routes/console.ts's
 * own doc comment on GET /orgs/:orgId/connectors's explicit column
 * allowlist).
 *
 * Slice 3e: each Members row now links to `/console/users/:userId` (User
 * Detail), same row-click-to-detail pattern as ConsoleDirectoryClient's own
 * rows — the one place besides the new Users list screen that reaches it.
 */
export default function ConsoleOrgDetailClient({
  org: initialOrg,
  runs,
  connectors,
}: {
  org: ConsoleOrgDetail;
  runs: ConsoleRun[] | null;
  connectors: ConsoleConnector[] | null;
}) {
  const [org, setOrg] = useState(initialOrg);
  const [activeTab, setActiveTab] = useState<'members' | 'runs' | 'connectors'>('members');
  const [isEditing, setIsEditing] = useState(false);
  const [planTier, setPlanTier] = useState(org.planTier);
  const [workflowLimit, setWorkflowLimit] = useState(org.workflowLimit === null ? '' : String(org.workflowLimit));
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const orgMeta = `${org.planTier} · ${org.members.length} people · ${org.runs30d} runs in 30 days · ${org.status}`;

  // Live preview while typing: the trigger only blocks NEW inserts (it
  // fires on INSERT, never UPDATE/DELETE), so lowering the limit below
  // org.workflowsUsed never touches existing rows — this is purely an
  // informational heads-up for staff before they click Save, not a
  // client-side validation error (a limit below current usage is a valid,
  // intentional save).
  const trimmedLimitPreview = workflowLimit.trim();
  const parsedLimitPreview =
    trimmedLimitPreview && Number.isInteger(Number(trimmedLimitPreview)) && Number(trimmedLimitPreview) > 0
      ? Number(trimmedLimitPreview)
      : null;
  const lowerLimitWarning = formatLowerLimitWarning(org.workflowsUsed, parsedLimitPreview);

  function startEditing() {
    setPlanTier(org.planTier);
    setWorkflowLimit(org.workflowLimit === null ? '' : String(org.workflowLimit));
    setFormError(null);
    setIsEditing(true);
  }

  function handleSave() {
    const trimmedTier = planTier.trim();
    if (!trimmedTier) {
      setFormError('Plan is required.');
      return;
    }
    const trimmedLimit = workflowLimit.trim();
    let parsedLimit: number | null = null;
    if (trimmedLimit) {
      const n = Number(trimmedLimit);
      if (!Number.isInteger(n) || n <= 0) {
        setFormError('Workflow limit must be a positive whole number, or blank for unlimited.');
        return;
      }
      parsedLimit = n;
    }

    setFormError(null);
    startTransition(async () => {
      const result = await updateOrgPlanAction(org.id, trimmedTier, parsedLimit);
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      setOrg((prev) => ({ ...prev, planTier: result.planTier, workflowLimit: result.workflowLimit }));
      setIsEditing(false);
    });
  }

  // Slice 3b (console-plan.md, decisions 1-2, additions 3-6): the one
  // header action this screen adds — mirrors the plan-edit form's own
  // inline-form-not-modal pattern above (startSuspending/startUnsuspending
  // toggle a form in place of the header actions, Confirm/Cancel submit
  // via a separate useTransition so a slow request can't be confused with
  // the plan form's own pending state). A separate `suspendError` (rather
  // than reusing `formError`) keeps this fully independent of the plan
  // form, since both could theoretically be mid-edit at once (they don't
  // share any state).
  const [suspendMode, setSuspendMode] = useState<'none' | 'suspend' | 'unsuspend'>('none');
  const [suspendReason, setSuspendReason] = useState('');
  const [unsuspendNote, setUnsuspendNote] = useState('');
  const [suspendError, setSuspendError] = useState<string | null>(null);
  const [isSuspendPending, startSuspendTransition] = useTransition();

  function startSuspending() {
    setSuspendReason('');
    setSuspendError(null);
    setSuspendMode('suspend');
  }

  function startUnsuspending() {
    setUnsuspendNote('');
    setSuspendError(null);
    setSuspendMode('unsuspend');
  }

  function handleSuspend() {
    const reason = suspendReason.trim();
    if (!reason) {
      setSuspendError('Reason is required.');
      return;
    }
    setSuspendError(null);
    startSuspendTransition(async () => {
      const result = await suspendOrgAction(org.id, reason);
      if (!result.ok) {
        setSuspendError(result.error);
        return;
      }
      setOrg((prev) => ({
        ...prev,
        status: result.status,
        suspendedAt: result.suspendedAt,
        suspendedReason: result.suspendedReason,
      }));
      setSuspendMode('none');
    });
  }

  function handleUnsuspend() {
    setSuspendError(null);
    startSuspendTransition(async () => {
      const result = await unsuspendOrgAction(org.id, unsuspendNote);
      if (!result.ok) {
        setSuspendError(result.error);
        return;
      }
      setOrg((prev) => ({ ...prev, status: result.status, suspendedAt: null, suspendedReason: null, suspendedBy: null }));
      setSuspendMode('none');
    });
  }

  return (
    <div style={consoleContentStyle}>
      <div style={consoleBreadcrumbRowStyle}>
        <Link href="/console" style={consoleBreadcrumbLinkStyle}>
          Directory
        </Link>
        <span style={consoleBreadcrumbSepStyle}>/</span>
        <span style={consoleBreadcrumbCurrentStyle}>{org.name}</span>
      </div>

      <div style={consoleHeaderRowStyle}>
        <div style={consoleDetailHeaderTitleColStyle}>
          <span style={consoleHeaderTitleStyle}>
            {org.name} {org.status === 'Suspended' && <span style={consoleSuspendedBadgeStyle}>Suspended</span>}
          </span>
          <span style={consoleHeaderSubStyle}>{orgMeta}</span>
          {org.status === 'Suspended' && (
            <span style={consoleSuspendMetaStyle}>
              {org.suspendedBy ? `Suspended by ${org.suspendedBy.name ?? org.suspendedBy.userId}` : 'Suspended'}
              {org.suspendedReason ? ` · Reason: ${org.suspendedReason}` : ''}
            </span>
          )}
        </div>
        {suspendMode === 'none' && (
          <div style={consoleHeaderActionsStyle}>
            {org.status === 'Suspended' ? (
              <button type="button" onClick={startUnsuspending} style={consolePrimaryBtnStyle}>
                Unsuspend
              </button>
            ) : (
              <button type="button" onClick={startSuspending} style={consoleDangerBtnStyle}>
                Suspend
              </button>
            )}
          </div>
        )}
      </div>

      {suspendMode === 'suspend' && (
        <div style={consoleSuspendFormStyle}>
          <div style={consolePlanFieldStyle}>
            <label htmlFor="console-suspend-reason" style={consolePlanFieldLabelStyle}>
              Reason
            </label>
            <textarea
              id="console-suspend-reason"
              value={suspendReason}
              onChange={(e) => setSuspendReason(e.target.value)}
              disabled={isSuspendPending}
              style={consoleSuspendTextareaStyle}
              placeholder="Why is this organization being suspended?"
            />
          </div>
          <div style={consolePlanFormActionsStyle}>
            <button type="button" onClick={handleSuspend} disabled={isSuspendPending} style={consoleDangerBtnStyle}>
              {isSuspendPending ? 'Suspending…' : 'Confirm suspend'}
            </button>
            <button
              type="button"
              onClick={() => setSuspendMode('none')}
              disabled={isSuspendPending}
              style={consoleGhostBtnStyle}
            >
              Cancel
            </button>
          </div>
          {suspendError && <span style={consolePlanFormErrorStyle}>{suspendError}</span>}
        </div>
      )}

      {suspendMode === 'unsuspend' && (
        <div style={consoleSuspendFormStyle}>
          <div style={consolePlanFieldStyle}>
            <label htmlFor="console-unsuspend-note" style={consolePlanFieldLabelStyle}>
              Note (optional)
            </label>
            <textarea
              id="console-unsuspend-note"
              value={unsuspendNote}
              onChange={(e) => setUnsuspendNote(e.target.value)}
              disabled={isSuspendPending}
              style={consoleSuspendTextareaStyle}
              placeholder="Optional note for the audit log"
            />
          </div>
          <div style={consolePlanFormActionsStyle}>
            <button type="button" onClick={handleUnsuspend} disabled={isSuspendPending} style={consolePrimaryBtnStyle}>
              {isSuspendPending ? 'Unsuspending…' : 'Confirm unsuspend'}
            </button>
            <button
              type="button"
              onClick={() => setSuspendMode('none')}
              disabled={isSuspendPending}
              style={consoleGhostBtnStyle}
            >
              Cancel
            </button>
          </div>
          {suspendError && <span style={consolePlanFormErrorStyle}>{suspendError}</span>}
        </div>
      )}

      <div style={consoleStatsRowStyle}>
        {isEditing ? (
          <div style={consolePlanFormStyle}>
            <div style={consolePlanFieldStyle}>
              <label htmlFor="console-plan-tier" style={consolePlanFieldLabelStyle}>
                Plan
              </label>
              <input
                id="console-plan-tier"
                value={planTier}
                onChange={(e) => setPlanTier(e.target.value)}
                disabled={isPending}
                style={consolePlanInputStyle}
              />
            </div>
            <div style={consolePlanFieldStyle}>
              <label htmlFor="console-workflow-limit" style={consolePlanFieldLabelStyle}>
                Workflow limit
              </label>
              <input
                id="console-workflow-limit"
                value={workflowLimit}
                onChange={(e) => setWorkflowLimit(e.target.value)}
                placeholder="Unlimited"
                inputMode="numeric"
                disabled={isPending}
                style={consolePlanInputStyle}
              />
            </div>
            <div style={consolePlanFormActionsStyle}>
              <button type="button" onClick={handleSave} disabled={isPending} style={consolePrimaryBtnStyle}>
                {isPending ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => setIsEditing(false)}
                disabled={isPending}
                style={consoleGhostBtnStyle}
              >
                Cancel
              </button>
            </div>
            {!formError && lowerLimitWarning && <span style={consolePlanFormWarningStyle}>{lowerLimitWarning}</span>}
            {formError && <span style={consolePlanFormErrorStyle}>{formError}</span>}
          </div>
        ) : (
          <>
            <div style={consoleStatCardStyle}>
              <span style={consoleStatLabelStyle}>Plan</span>
              <span style={consoleStatValueStyle}>{org.planTier}</span>
            </div>
            <div style={consoleStatCardStyle}>
              <span style={consoleStatLabelStyle}>Workflow limit</span>
              <span style={consoleStatValueStyle}>{org.workflowLimit === null ? 'Unlimited' : org.workflowLimit}</span>
            </div>
            <div style={consoleStatCardStyle}>
              <span style={consoleStatLabelStyle}>Workflows used</span>
              <span style={consoleStatValueStyle}>{org.workflowsUsed}</span>
            </div>
            <button type="button" onClick={startEditing} style={consoleGhostBtnStyle}>
              Edit plan
            </button>
          </>
        )}
      </div>

      <div style={consoleTabsRowStyle}>
        <button type="button" onClick={() => setActiveTab('members')} style={consoleTabStyle(activeTab === 'members')}>
          Members
        </button>
        <button type="button" onClick={() => setActiveTab('runs')} style={consoleTabStyle(activeTab === 'runs')}>
          Runs
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('connectors')}
          style={consoleTabStyle(activeTab === 'connectors')}
        >
          Connectors
        </button>
      </div>

      {activeTab === 'members' && (
        <div style={consoleTableStyle}>
          <div style={consoleTableHeadRowStyle}>
            <span style={consoleColMemberStyle}>Member</span>
            <span style={consoleColEmailStyle}>Email</span>
            <span style={consoleColRoleStyle}>Role</span>
            <span style={consoleColJoinedStyle}>Joined</span>
          </div>

          {org.members.length === 0 && <div style={consoleEmptyStyle}>No members.</div>}

          {org.members.map((m) => (
            <Link key={m.userId} href={`/console/users/${m.userId}`} style={consoleRowLinkStyle}>
              <div style={consoleRowStyle}>
                <span style={consoleRowMemberCellStyle}>
                  <span style={consoleMonoStyle}>{initialsOf(m.name)}</span>
                  <span style={consoleRowNameColStyle}>
                    <span style={consoleRowNameStyle}>{m.name}</span>
                  </span>
                </span>
                <span style={consoleRowEmailCellStyle}>{m.email}</span>
                <span style={consoleRowRoleCellStyle}>{m.role}</span>
                <span style={consoleRowJoinedCellStyle}>{formatDate(m.joinedAt)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {activeTab === 'runs' && (
        <>
          {/* Small fix (2026-09-29): always label the cap so it never reads
              as a silent truncation, whether the list is full, short, empty,
              or failed to load. */}
          <div style={consoleRunsCaptionStyle}>Showing the latest 50 runs</div>

          {runs === null ? (
            <div style={consoleLoadMoreErrorStyle}>Couldn&apos;t load runs.</div>
          ) : (
            <div style={consoleTableStyle}>
              <div style={consoleTableHeadRowStyle}>
                <span style={consoleColRunStatusStyle}>Status</span>
                <span style={consoleColRunStartedStyle}>Started</span>
                <span style={consoleColRunDurationStyle}>Duration</span>
                <span style={consoleColRunErrorStyle}>Error</span>
              </div>

              {runs.length === 0 && <div style={consoleEmptyStyle}>No runs.</div>}

              {runs.map((r) => (
                <div key={r.id} style={consoleRowStyle}>
                  <span style={consoleRowRunStatusCellStyle}>
                    <span style={consolePillStyle(runStatusTone(r.status))}>{r.status}</span>
                  </span>
                  <span style={consoleRowRunStartedCellStyle}>{formatDate(r.startedAt)}</span>
                  <span style={consoleRowRunDurationCellStyle}>{formatDuration(r.durationMs)}</span>
                  <span style={consoleRowRunErrorCellStyle} title={r.error?.message ?? ''}>
                    {r.error?.message ?? '—'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {activeTab === 'connectors' &&
        (connectors === null ? (
          <div style={consoleLoadMoreErrorStyle}>Couldn&apos;t load connectors.</div>
        ) : (
          <div style={consoleTableStyle}>
            <div style={consoleTableHeadRowStyle}>
              <span style={consoleColConnectorTypeStyle}>Type</span>
              <span style={consoleColConnectorNameStyle}>Name</span>
              <span style={consoleColConnectorHealthStyle}>Health</span>
              <span style={consoleColConnectorCreatedStyle}>Created</span>
            </div>

            {connectors.length === 0 && <div style={consoleEmptyStyle}>No connectors.</div>}

            {connectors.map((c) => (
              <div key={c.id} style={consoleRowStyle}>
                <span style={consoleRowConnectorTypeCellStyle}>{c.connectorId}</span>
                <span style={consoleRowConnectorNameCellStyle}>{c.displayName}</span>
                <span style={consoleRowConnectorHealthCellStyle}>
                  <span style={consolePillStyle(connectorHealthTone(c.lastTestStatus))}>
                    {c.lastTestStatus ?? 'Untested'}
                  </span>
                  {c.lastTestLatencyMs !== null && (
                    <span style={consoleRowConnectorHealthLatencyStyle}>{c.lastTestLatencyMs}ms</span>
                  )}
                </span>
                <span style={consoleRowConnectorCreatedCellStyle}>{formatDate(c.createdAt)}</span>
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

function connectorHealthTone(status: 'ok' | 'error' | null): 'ok' | 'bad' | 'neutral' {
  if (status === 'ok') return 'ok';
  if (status === 'error') return 'bad';
  return 'neutral';
}

function runStatusTone(status: string): 'ok' | 'warn' | 'bad' | 'neutral' {
  if (status === 'succeeded') return 'ok';
  if (status === 'failed') return 'bad';
  if (status === 'cancelled') return 'neutral';
  return 'warn';
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
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
