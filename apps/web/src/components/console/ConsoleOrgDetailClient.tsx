'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import type {
  ConsoleConnector,
  ConsoleOrgDetail,
  ConsolePlan,
  ConsolePlanOverrideFields,
  ConsoleRun,
  ConsoleUsageSummary,
  ConsoleUsageTimeseriesPoint,
} from '@/lib/api/consoleServer';
import { removeMemberAction, suspendOrgAction, unsuspendOrgAction, updateOrgPlanAction } from '@/lib/console/actions';
import { formatPlanExpiry } from '@/lib/console/planLimitWarning';
import ConsoleUsageCharts, { formatUsd } from './ConsoleUsageCharts';
import PlanOverrideForm from './PlanOverrideForm';
import StatusPill, { type StatusTone } from './StatusPill';
import {
  consoleBreadcrumbCurrentStyle,
  consoleBreadcrumbLinkStyle,
  consoleBreadcrumbRowStyle,
  consoleBreadcrumbSepStyle,
  consoleColActionsStyle,
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
  consolePlanFieldLabelStyle,
  consolePlanFieldStyle,
  consolePlanFormActionsStyle,
  consolePlanFormErrorStyle,
  consolePrimaryBtnStyle,
  consoleRowConnectorCreatedCellStyle,
  consoleRowConnectorHealthCellStyle,
  consoleRowConnectorHealthLatencyStyle,
  consoleRowConnectorNameCellStyle,
  consoleRowActionsCellStyle,
  consoleRowConnectorTypeCellStyle,
  consoleRowEmailCellStyle,
  consoleRowJoinedCellStyle,
  consoleRowMemberCellStyle,
  consoleRowMemberLinkStyle,
  consoleRowNameColStyle,
  consoleRowNameStyle,
  consoleRowRemoveBtnStyle,
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
 * ghost button next to the stat row toggles it into an inline form
 * (Save/Cancel) rather than a modal — consistent with the minimalist
 * convention above. Subscription model Phase 1 extended this form: a plan
 * dropdown (bound to the `plans` prop, from GET /console/plans) replaces
 * the old free-text plan-tier input, and each of workflow/project limit
 * gets its own override checkbox + number input pair — unchecked means
 * "inherit the selected plan's default" (the "Clear override" state), an
 * empty override input while checked means an explicit unlimited
 * override, matching org_plan's own tri-state semantics (see
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
 *
 * Subscription Phase 3, Slice 5 (decision 8): two more stat cards, rows
 * moved and Copilot actions this month, appended to the existing
 * plan/limits/usage row — display-only (no edit form, unlike workflow/
 * project limit, since org_plan has no override columns for these).
 *
 * Subscription Phase 5, Slice 6 (decision 2): the Members row's "no per-row
 * ··· menu" note above is now superseded for one specific action —
 * "Remove from org". Same inline-form-not-modal, required-reason
 * confirmation pattern as the header's suspend/unsuspend form (`removeMode`
 * mirrors `suspendMode`, reusing its exact form styles), but scoped per
 * row (keyed by userId) since removal targets one specific member rather
 * than the whole org. The row itself can no longer be a single <Link> (a
 * nested <button> would double-fire navigation) — see
 * consoleRowMemberLinkStyle's own doc comment in styles.ts.
 */
export default function ConsoleOrgDetailClient({
  org: initialOrg,
  plans,
  runs,
  connectors,
  usageSummary,
  usageTimeseries,
}: {
  org: ConsoleOrgDetail;
  plans: ConsolePlan[];
  runs: ConsoleRun[] | null;
  connectors: ConsoleConnector[] | null;
  usageSummary: ConsoleUsageSummary | null;
  usageTimeseries: ConsoleUsageTimeseriesPoint[] | null;
}) {
  const [org, setOrg] = useState(initialOrg);
  const [activeTab, setActiveTab] = useState<'members' | 'runs' | 'connectors' | 'tokens'>('members');
  const [isEditing, setIsEditing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const orgMeta = `${org.effectivePlanTier} · ${org.members.length} people · ${org.runs30d} runs in 30 days · ${org.status}`;
  const planExpiryNote = formatPlanExpiry(org.grantExpiresAt, org.grantExpired);

  function handleSave(values: ConsolePlanOverrideFields & { reason: string }) {
    setFormError(null);
    startTransition(async () => {
      const result = await updateOrgPlanAction(
        org.id,
        values.planId,
        values.workflowLimitOverrideSet,
        values.workflowLimitOverride,
        values.projectLimitOverrideSet,
        values.projectLimitOverride,
        values.grantPlanId,
        values.grantCopilotActionsPerMonthOverrideSet,
        values.grantCopilotActionsPerMonthOverride,
        values.grantRowsPerMonthOverrideSet,
        values.grantRowsPerMonthOverride,
        values.grantExpiresAt,
        values.reason,
      );
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      const newBasePlan = plans.find((p) => p.id === result.planId);
      const grantExpired = result.grantExpiresAt !== null && new Date(result.grantExpiresAt).getTime() < Date.now();
      const effectivePlan = !grantExpired && result.grantPlanId ? plans.find((p) => p.id === result.grantPlanId) : newBasePlan;
      setOrg((prev) => ({
        ...prev,
        planId: result.planId,
        planTier: newBasePlan?.name ?? prev.planTier,
        effectivePlanId: effectivePlan?.id ?? result.planId,
        effectivePlanTier: effectivePlan?.name ?? newBasePlan?.name ?? prev.planTier,
        workflowLimitOverrideSet: result.workflowLimitOverrideSet,
        workflowLimitOverride: result.workflowLimitOverride,
        workflowLimit: result.workflowLimitOverrideSet ? result.workflowLimitOverride : newBasePlan?.workflowLimit ?? null,
        projectLimitOverrideSet: result.projectLimitOverrideSet,
        projectLimitOverride: result.projectLimitOverride,
        projectLimit: result.projectLimitOverrideSet ? result.projectLimitOverride : newBasePlan?.projectLimit ?? null,
        grantPlanId: result.grantPlanId,
        grantCopilotActionsPerMonthOverrideSet: result.grantCopilotActionsPerMonthOverrideSet,
        grantCopilotActionsPerMonthOverride: result.grantCopilotActionsPerMonthOverride,
        copilotLimit:
          !grantExpired && result.grantCopilotActionsPerMonthOverrideSet
            ? result.grantCopilotActionsPerMonthOverride
            : effectivePlan?.copilotActionsPerMonth ?? null,
        grantRowsPerMonthOverrideSet: result.grantRowsPerMonthOverrideSet,
        grantRowsPerMonthOverride: result.grantRowsPerMonthOverride,
        rowsLimit:
          !grantExpired && result.grantRowsPerMonthOverrideSet
            ? result.grantRowsPerMonthOverride
            : effectivePlan?.rowsPerMonth ?? null,
        grantExpiresAt: result.grantExpiresAt,
        grantReason: values.reason,
        grantExpired,
      }));
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

  // Slice 6 (decision 2): removeTargetId is the userId whose row has its
  // confirm form open (null = none open) — mirrors suspendMode's
  // none/suspend/unsuspend shape, just keyed per row instead of once per
  // screen.
  const [removeTargetId, setRemoveTargetId] = useState<string | null>(null);
  const [removeReason, setRemoveReason] = useState('');
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [isRemovePending, startRemoveTransition] = useTransition();

  function startRemoving(userId: string) {
    setRemoveReason('');
    setRemoveError(null);
    setRemoveTargetId(userId);
  }

  function handleRemove(userId: string) {
    const reason = removeReason.trim();
    if (!reason) {
      setRemoveError('Reason is required.');
      return;
    }
    setRemoveError(null);
    startRemoveTransition(async () => {
      const result = await removeMemberAction(org.id, userId, reason);
      if (!result.ok) {
        setRemoveError(result.error);
        return;
      }
      setOrg((prev) => ({ ...prev, members: prev.members.filter((m) => m.userId !== userId) }));
      setRemoveTargetId(null);
    });
  }

  return (
    <div style={consoleContentStyle}>
      <div style={consoleBreadcrumbRowStyle}>
        <Link href="/console" style={consoleBreadcrumbLinkStyle}>
          Organizations
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
          <PlanOverrideForm
            plans={plans}
            initial={{
              planId: org.planId,
              workflowLimitOverrideSet: org.workflowLimitOverrideSet,
              workflowLimitOverride: org.workflowLimitOverride,
              projectLimitOverrideSet: org.projectLimitOverrideSet,
              projectLimitOverride: org.projectLimitOverride,
              grantPlanId: org.grantPlanId,
              grantCopilotActionsPerMonthOverrideSet: org.grantCopilotActionsPerMonthOverrideSet,
              grantCopilotActionsPerMonthOverride: org.grantCopilotActionsPerMonthOverride,
              grantRowsPerMonthOverrideSet: org.grantRowsPerMonthOverrideSet,
              grantRowsPerMonthOverride: org.grantRowsPerMonthOverride,
              grantExpiresAt: org.grantExpiresAt,
            }}
            workflowsUsed={org.workflowsUsed}
            projectsUsed={org.projectsUsed}
            isPending={isPending}
            error={formError}
            onSave={handleSave}
            onCancel={() => setIsEditing(false)}
          />
        ) : (
          <>
            <div style={consoleStatCardStyle}>
              <span style={consoleStatLabelStyle}>Plan</span>
              <span style={consoleStatValueStyle}>
                {org.effectivePlanTier}
                {org.grantPlanId && org.effectivePlanTier !== org.planTier && (
                  <span style={consoleHeaderSubStyle}> (base: {org.planTier})</span>
                )}
                {planExpiryNote && <span style={consoleHeaderSubStyle}> · {planExpiryNote}</span>}
              </span>
            </div>
            <div style={consoleStatCardStyle}>
              <span style={consoleStatLabelStyle}>Workflow limit</span>
              <span style={consoleStatValueStyle}>{org.workflowLimit === null ? 'Unlimited' : org.workflowLimit}</span>
            </div>
            <div style={consoleStatCardStyle}>
              <span style={consoleStatLabelStyle}>Workflows used</span>
              <span style={consoleStatValueStyle}>{org.workflowsUsed}</span>
            </div>
            <div style={consoleStatCardStyle}>
              <span style={consoleStatLabelStyle}>Project limit</span>
              <span style={consoleStatValueStyle}>{org.projectLimit === null ? 'Unlimited' : org.projectLimit}</span>
            </div>
            <div style={consoleStatCardStyle}>
              <span style={consoleStatLabelStyle}>Projects used</span>
              <span style={consoleStatValueStyle}>{org.projectsUsed}</span>
            </div>
            <div style={consoleStatCardStyle}>
              <span style={consoleStatLabelStyle}>Rows moved this month</span>
              <span style={consoleStatValueStyle}>
                {org.rowsUsed.toLocaleString()}
                {org.rowsLimit !== null && ` / ${org.rowsLimit.toLocaleString()}`}
              </span>
            </div>
            <div style={consoleStatCardStyle}>
              <span style={consoleStatLabelStyle}>Copilot actions this month</span>
              <span style={consoleStatValueStyle}>
                {org.copilotUsed.toLocaleString()}
                {org.copilotLimit !== null && ` / ${org.copilotLimit.toLocaleString()}`}
              </span>
            </div>
            <button type="button" onClick={() => setIsEditing(true)} style={consoleGhostBtnStyle}>
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
        <button type="button" onClick={() => setActiveTab('tokens')} style={consoleTabStyle(activeTab === 'tokens')}>
          Tokens
        </button>
      </div>

      {activeTab === 'members' && (
        <div style={consoleTableStyle}>
          <div style={consoleTableHeadRowStyle}>
            <span style={consoleColMemberStyle}>Member</span>
            <span style={consoleColEmailStyle}>Email</span>
            <span style={consoleColRoleStyle}>Role</span>
            <span style={consoleColJoinedStyle}>Joined</span>
            <span style={consoleColActionsStyle} />
          </div>

          {org.members.length === 0 && <div style={consoleEmptyStyle}>No members.</div>}

          {org.members.map((m) => (
            <div key={m.userId}>
              <div style={consoleRowStyle}>
                <Link href={`/console/users/${m.userId}`} style={consoleRowMemberLinkStyle}>
                  <span style={consoleRowMemberCellStyle}>
                    <span style={consoleMonoStyle}>{initialsOf(m.name)}</span>
                    <span style={consoleRowNameColStyle}>
                      <span style={consoleRowNameStyle}>{m.name}</span>
                    </span>
                  </span>
                  <span style={consoleRowEmailCellStyle}>{m.email}</span>
                  <span style={consoleRowRoleCellStyle}>{m.role}</span>
                  <span style={consoleRowJoinedCellStyle}>{formatDate(m.joinedAt)}</span>
                </Link>
                <span style={consoleRowActionsCellStyle}>
                  {removeTargetId !== m.userId && (
                    <button type="button" onClick={() => startRemoving(m.userId)} style={consoleRowRemoveBtnStyle}>
                      Remove
                    </button>
                  )}
                </span>
              </div>
              {removeTargetId === m.userId && (
                <div style={consoleSuspendFormStyle}>
                  <div style={consolePlanFieldStyle}>
                    <label htmlFor={`console-remove-reason-${m.userId}`} style={consolePlanFieldLabelStyle}>
                      Reason
                    </label>
                    <textarea
                      id={`console-remove-reason-${m.userId}`}
                      value={removeReason}
                      onChange={(e) => setRemoveReason(e.target.value)}
                      disabled={isRemovePending}
                      style={consoleSuspendTextareaStyle}
                      placeholder={`Why is ${m.name} being removed from ${org.name}?`}
                    />
                  </div>
                  <div style={consolePlanFormActionsStyle}>
                    <button
                      type="button"
                      onClick={() => handleRemove(m.userId)}
                      disabled={isRemovePending}
                      style={consoleDangerBtnStyle}
                    >
                      {isRemovePending ? 'Removing…' : 'Confirm remove'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setRemoveTargetId(null)}
                      disabled={isRemovePending}
                      style={consoleGhostBtnStyle}
                    >
                      Cancel
                    </button>
                  </div>
                  {removeError && <span style={consolePlanFormErrorStyle}>{removeError}</span>}
                </div>
              )}
            </div>
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
                    <StatusPill tone={runStatusTone(r.status)} label={r.status} />
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
                  <StatusPill tone={connectorHealthTone(c.lastTestStatus)} label={c.lastTestStatus ?? 'Untested'} />
                  {c.lastTestLatencyMs !== null && (
                    <span style={consoleRowConnectorHealthLatencyStyle}>{c.lastTestLatencyMs}ms</span>
                  )}
                </span>
                <span style={consoleRowConnectorCreatedCellStyle}>{formatDate(c.createdAt)}</span>
              </div>
            ))}
          </div>
        ))}

      {activeTab === 'tokens' &&
        (usageSummary === null || usageTimeseries === null ? (
          <div style={consoleLoadMoreErrorStyle}>Couldn&apos;t load token usage.</div>
        ) : (
          <>
            <div style={consoleStatsRowStyle}>
              <div style={consoleStatCardStyle}>
                <span style={consoleStatLabelStyle}>Today — tokens</span>
                <span style={consoleStatValueStyle}>{usageSummary.today.totalTokens.toLocaleString()}</span>
              </div>
              <div style={consoleStatCardStyle}>
                <span style={consoleStatLabelStyle}>Today — cost</span>
                <span style={consoleStatValueStyle}>{formatUsd(usageSummary.today.cost)}</span>
              </div>
              <div style={consoleStatCardStyle}>
                <span style={consoleStatLabelStyle}>This month — tokens</span>
                <span style={consoleStatValueStyle}>{usageSummary.month.totalTokens.toLocaleString()}</span>
              </div>
              <div style={consoleStatCardStyle}>
                <span style={consoleStatLabelStyle}>This month — cost</span>
                <span style={consoleStatValueStyle}>{formatUsd(usageSummary.month.cost)}</span>
              </div>
            </div>
            <ConsoleUsageCharts timeseries={usageTimeseries} />
          </>
        ))}
    </div>
  );
}

function connectorHealthTone(status: 'ok' | 'error' | null): StatusTone {
  if (status === 'ok') return 'success';
  if (status === 'error') return 'error';
  return 'neutral';
}

function runStatusTone(status: string): StatusTone {
  if (status === 'succeeded') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'cancelled') return 'neutral';
  return 'running';
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
