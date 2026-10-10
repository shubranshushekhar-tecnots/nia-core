'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import type { ConsolePlan, ConsolePlanOverrideFields, ConsoleUserDetail } from '@/lib/api/consoleServer';
import { revokeUserSessionsAction, updateUserPlanAction } from '@/lib/console/actions';
import { formatPlanExpiry } from '@/lib/console/planLimitWarning';
import PlanOverrideForm from './PlanOverrideForm';
import {
  consoleBreadcrumbCurrentStyle,
  consoleBreadcrumbLinkStyle,
  consoleBreadcrumbRowStyle,
  consoleBreadcrumbSepStyle,
  consoleColJoinedStyle,
  consoleColMemberStyle,
  consoleColPlanStyle,
  consoleColRoleStyle,
  consoleContentStyle,
  consoleDangerBtnStyle,
  consoleDetailHeaderTitleColStyle,
  consoleEmptyStyle,
  consoleGhostBtnStyle,
  consoleHeaderActionsStyle,
  consoleHeaderRowStyle,
  consoleHeaderSubStyle,
  consoleHeaderTitleStyle,
  consolePlanFieldLabelStyle,
  consolePlanFieldStyle,
  consolePlanFormActionsStyle,
  consolePlanFormErrorStyle,
  consolePlanFormWarningStyle,
  consoleRowJoinedCellStyle,
  consoleRowLinkStyle,
  consoleRowPlanStyle,
  consoleRowRoleCellStyle,
  consoleRowStyle,
  consoleSectionTitleStyle,
  consoleStatCardStyle,
  consoleStatLabelStyle,
  consoleStatsRowStyle,
  consoleStatValueStyle,
  consoleSuspendFormStyle,
  consoleSuspendTextareaStyle,
  consoleTableHeadRowStyle,
  consoleTableStyle,
} from './styles';

/**
 * Console v1 User Detail screen (docs/plans/console-plan.md build order
 * step 12, Slice 3e). Reached only via a link from the Users list or an
 * org detail Members row (ConsoleShell's NAV has no entry for it — see its
 * own doc comment), same as Org Detail. Breadcrumb/header/stat-card layout
 * mirrors ConsoleOrgDetailClient's own precedent for this Console's one
 * other detail screen.
 *
 * Profile, org memberships (with role), and session count/last-sign-in
 * only — never a password, token, or 2FA-secret field, matching
 * routes/console.ts's own doc comment on this route's explicit SELECT/
 * response allowlist. No per-membership "···" menu: that one still doesn't
 * exist yet (same "don't render a non-functional control" convention as
 * every other Console screen's doc comment) — but Slice 3f (build order
 * step 13) does add one real header action: "Sign out everywhere".
 *
 * Same inline-form-not-modal pattern as ConsoleOrgDetailClient's own
 * suspend/unsuspend control (`revokeMode` in place of `suspendMode`,
 * reusing that screen's exact suspend-form styles rather than inventing
 * new ones — this is also a required-reason destructive confirmation).
 * `currentStaffUserId` (the signed-in staff member's own id, threaded down
 * from app/console/users/[userId]/page.tsx's own getSessionUser() call) is
 * used only to show a client-side warning when a staffer is about to revoke
 * their *own* sessions — the backend allows this unconditionally (see
 * routes/console.ts's doc comment on POST .../revoke-sessions), so this is
 * pure confirmation copy, not a permission check.
 *
 * Plan-visibility work: adds a "Plan & limits" section, right after the
 * header actions. For an org member (`workspaceType === 'org'`), it's
 * read-only — the effective plan is always the org's, so editing happens
 * on `/console/orgs/[orgId]` instead (same `plans` lookup the memberships
 * table's new Plan column uses). For an individual user, it's the same
 * editable tri-state form as ConsoleOrgDetailClient's plan editor, reusing
 * the shared `PlanOverrideForm` component 1:1 (`user.individualPlan` is
 * guaranteed non-null by the API in this case — see consoleServer.ts's
 * doc comment on `ConsoleUserDetail`).
 */
export default function ConsoleUserDetailClient({
  user,
  plans,
  currentStaffUserId,
}: {
  user: ConsoleUserDetail;
  plans: ConsolePlan[];
  currentStaffUserId: string;
}) {
  const meta = `${user.email} · ${user.memberships.length} orgs · Joined ${formatDate(user.createdAt)}`;

  const [sessionCount, setSessionCount] = useState(user.sessionCount);
  const [revokeMode, setRevokeMode] = useState(false);
  const [revokeReason, setRevokeReason] = useState('');
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokeDone, setRevokeDone] = useState<number | null>(null);
  const [isRevokePending, startRevokeTransition] = useTransition();

  const [individualPlan, setIndividualPlan] = useState(user.individualPlan);
  const [isEditingPlan, setIsEditingPlan] = useState(false);
  const [planFormError, setPlanFormError] = useState<string | null>(null);
  const [isPlanPending, startPlanTransition] = useTransition();

  const isSelf = user.id === currentStaffUserId;

  function planName(planId: string): string {
    return plans.find((p) => p.id === planId)?.name ?? planId;
  }

  function startRevoking() {
    setRevokeReason('');
    setRevokeError(null);
    setRevokeMode(true);
  }

  function handleRevoke() {
    const reason = revokeReason.trim();
    if (!reason) {
      setRevokeError('Reason is required.');
      return;
    }
    setRevokeError(null);
    startRevokeTransition(async () => {
      const result = await revokeUserSessionsAction(user.id, reason);
      if (!result.ok) {
        setRevokeError(result.error);
        return;
      }
      setSessionCount(0);
      setRevokeDone(result.revokedSessionCount);
      setRevokeMode(false);
    });
  }

  function handleSavePlan(values: ConsolePlanOverrideFields & { reason: string }) {
    setPlanFormError(null);
    startPlanTransition(async () => {
      const result = await updateUserPlanAction(
        user.id,
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
        setPlanFormError(result.error);
        return;
      }
      const newBasePlan = plans.find((p) => p.id === result.planId);
      const grantExpired = result.grantExpiresAt !== null && new Date(result.grantExpiresAt).getTime() < Date.now();
      const effectivePlan = !grantExpired && result.grantPlanId ? plans.find((p) => p.id === result.grantPlanId) : newBasePlan;
      setIndividualPlan((prev) => ({
        planId: result.planId,
        planName: newBasePlan?.name ?? prev?.planName ?? result.planId,
        effectivePlanId: effectivePlan?.id ?? result.planId,
        effectivePlanName: effectivePlan?.name ?? newBasePlan?.name ?? prev?.planName ?? result.planId,
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
      setIsEditingPlan(false);
    });
  }

  return (
    <div style={consoleContentStyle}>
      <div style={consoleBreadcrumbRowStyle}>
        <Link href="/console/users" style={consoleBreadcrumbLinkStyle}>
          Users
        </Link>
        <span style={consoleBreadcrumbSepStyle}>/</span>
        <span style={consoleBreadcrumbCurrentStyle}>{user.name || user.email}</span>
      </div>

      <div style={consoleHeaderRowStyle}>
        <div style={consoleDetailHeaderTitleColStyle}>
          <span style={consoleHeaderTitleStyle}>{user.name || user.email}</span>
          <span style={consoleHeaderSubStyle}>{meta}</span>
          {revokeDone !== null && (
            <span style={consolePlanFormWarningStyle}>Signed out of {revokeDone} session(s).</span>
          )}
        </div>
        {!revokeMode && (
          <div style={consoleHeaderActionsStyle}>
            <button type="button" onClick={startRevoking} style={consoleDangerBtnStyle}>
              Sign out everywhere
            </button>
          </div>
        )}
      </div>

      {revokeMode && (
        <div style={consoleSuspendFormStyle}>
          {isSelf && (
            <span style={consolePlanFormWarningStyle}>
              You are about to sign yourself out everywhere too — you&rsquo;ll need to log back in.
            </span>
          )}
          <div style={consolePlanFieldStyle}>
            <label htmlFor="console-revoke-reason" style={consolePlanFieldLabelStyle}>
              Reason
            </label>
            <textarea
              id="console-revoke-reason"
              value={revokeReason}
              onChange={(e) => setRevokeReason(e.target.value)}
              disabled={isRevokePending}
              style={consoleSuspendTextareaStyle}
              placeholder="Why is this user being signed out everywhere?"
            />
          </div>
          <div style={consolePlanFormActionsStyle}>
            <button type="button" onClick={handleRevoke} disabled={isRevokePending} style={consoleDangerBtnStyle}>
              {isRevokePending ? 'Signing out…' : 'Confirm sign out'}
            </button>
            <button
              type="button"
              onClick={() => setRevokeMode(false)}
              disabled={isRevokePending}
              style={consoleGhostBtnStyle}
            >
              Cancel
            </button>
          </div>
          {revokeError && <span style={consolePlanFormErrorStyle}>{revokeError}</span>}
        </div>
      )}

      <div style={consoleStatsRowStyle}>
        <div style={consoleStatCardStyle}>
          <span style={consoleStatLabelStyle}>Email verified</span>
          <span style={consoleStatValueStyle}>{user.emailVerified ? 'Yes' : 'No'}</span>
        </div>
        <div style={consoleStatCardStyle}>
          <span style={consoleStatLabelStyle}>Sessions</span>
          <span style={consoleStatValueStyle}>{sessionCount}</span>
        </div>
        <div style={consoleStatCardStyle}>
          <span style={consoleStatLabelStyle}>Last sign-in</span>
          <span style={consoleStatValueStyle}>{user.lastSignInAt ? formatDate(user.lastSignInAt) : '—'}</span>
        </div>
      </div>

      <span style={consoleSectionTitleStyle}>Plan & limits</span>

      {user.workspaceType === 'org' ? (
        <div style={consoleStatsRowStyle}>
          <div style={consoleStatCardStyle}>
            <span style={consoleStatLabelStyle}>Effective plan</span>
            <span style={consoleStatValueStyle}>{planName(user.memberships[0]?.planId ?? '')}</span>
          </div>
          <Link href={`/console/orgs/${user.memberships[0]?.orgId}`} style={consoleGhostBtnStyle}>
            Edit on organization page
          </Link>
        </div>
      ) : (
        <div style={consoleStatsRowStyle}>
          {isEditingPlan && individualPlan ? (
            <PlanOverrideForm
              plans={plans}
              initial={{
                planId: individualPlan.planId,
                workflowLimitOverrideSet: individualPlan.workflowLimitOverrideSet,
                workflowLimitOverride: individualPlan.workflowLimitOverride,
                projectLimitOverrideSet: individualPlan.projectLimitOverrideSet,
                projectLimitOverride: individualPlan.projectLimitOverride,
                grantPlanId: individualPlan.grantPlanId,
                grantCopilotActionsPerMonthOverrideSet: individualPlan.grantCopilotActionsPerMonthOverrideSet,
                grantCopilotActionsPerMonthOverride: individualPlan.grantCopilotActionsPerMonthOverride,
                grantRowsPerMonthOverrideSet: individualPlan.grantRowsPerMonthOverrideSet,
                grantRowsPerMonthOverride: individualPlan.grantRowsPerMonthOverride,
                grantExpiresAt: individualPlan.grantExpiresAt,
              }}
              isPending={isPlanPending}
              error={planFormError}
              onSave={handleSavePlan}
              onCancel={() => setIsEditingPlan(false)}
            />
          ) : (
            individualPlan && (
              <>
                <div style={consoleStatCardStyle}>
                  <span style={consoleStatLabelStyle}>Plan</span>
                  <span style={consoleStatValueStyle}>
                    {individualPlan.effectivePlanName}
                    {individualPlan.grantPlanId && individualPlan.effectivePlanName !== individualPlan.planName && (
                      <span style={consoleHeaderSubStyle}> (base: {individualPlan.planName})</span>
                    )}
                    {formatPlanExpiry(individualPlan.grantExpiresAt, individualPlan.grantExpired) && (
                      <span style={consoleHeaderSubStyle}>
                        {' '}
                        · {formatPlanExpiry(individualPlan.grantExpiresAt, individualPlan.grantExpired)}
                      </span>
                    )}
                  </span>
                </div>
                <div style={consoleStatCardStyle}>
                  <span style={consoleStatLabelStyle}>Workflow limit</span>
                  <span style={consoleStatValueStyle}>
                    {individualPlan.workflowLimit === null ? 'Unlimited' : individualPlan.workflowLimit}
                  </span>
                </div>
                <div style={consoleStatCardStyle}>
                  <span style={consoleStatLabelStyle}>Project limit</span>
                  <span style={consoleStatValueStyle}>
                    {individualPlan.projectLimit === null ? 'Unlimited' : individualPlan.projectLimit}
                  </span>
                </div>
                <div style={consoleStatCardStyle}>
                  <span style={consoleStatLabelStyle}>Copilot actions/mo</span>
                  <span style={consoleStatValueStyle}>
                    {individualPlan.copilotLimit === null ? 'Unlimited' : individualPlan.copilotLimit}
                  </span>
                </div>
                <div style={consoleStatCardStyle}>
                  <span style={consoleStatLabelStyle}>Rows/mo</span>
                  <span style={consoleStatValueStyle}>
                    {individualPlan.rowsLimit === null ? 'Unlimited' : individualPlan.rowsLimit}
                  </span>
                </div>
                <button type="button" onClick={() => setIsEditingPlan(true)} style={consoleGhostBtnStyle}>
                  Edit plan
                </button>
              </>
            )
          )}
        </div>
      )}

      <div style={consoleTableStyle}>
        <div style={consoleTableHeadRowStyle}>
          <span style={consoleColMemberStyle}>Organization</span>
          <span style={consoleColRoleStyle}>Role</span>
          <span style={consoleColPlanStyle}>Plan</span>
          <span style={consoleColJoinedStyle}>Joined</span>
        </div>

        {user.memberships.length === 0 && <div style={consoleEmptyStyle}>Not a member of any organization.</div>}

        {user.memberships.map((m) => (
          <Link key={m.orgId} href={`/console/orgs/${m.orgId}`} style={consoleRowLinkStyle}>
            <div style={consoleRowStyle}>
              <span style={consoleColMemberStyle}>{m.orgName}</span>
              <span style={consoleRowRoleCellStyle}>{m.role}</span>
              <span style={consoleRowPlanStyle}>{planName(m.planId)}</span>
              <span style={consoleRowJoinedCellStyle}>{formatDate(m.joinedAt)}</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
