'use client';

import { useState } from 'react';
import type { ConsolePlan, ConsolePlanOverrideFields } from '@/lib/api/consoleServer';
import { formatLowerLimitWarning } from '@/lib/console/planLimitWarning';
import {
  consoleGhostBtnStyle,
  consolePlanFieldLabelStyle,
  consolePlanFieldStyle,
  consolePlanFormActionsStyle,
  consolePlanFormErrorStyle,
  consolePlanFormStyle,
  consolePlanFormWarningStyle,
  consolePlanInputStyle,
  consolePlanOverrideLabelStyle,
  consolePlanOverrideRowStyle,
  consolePrimaryBtnStyle,
  consoleSuspendTextareaStyle,
} from './styles';

/**
 * Plan-visibility work: the tri-state plan-edit form shared by
 * ConsoleOrgDetailClient (org_plan) and ConsoleUserDetailClient
 * (owner_plan) — extracted here since `PATCH /console/orgs/:orgId/plan`
 * and `PATCH /console/users/:userId/plan` now take/return byte-identical
 * bodies (`ConsolePlanOverrideFields` + required `reason`, see
 * consoleServer.ts's own doc comment). Mounts fresh each time the caller
 * flips its `isEditing`-style flag to `true` (conditional render, not a
 * persistent instance), so it always re-initializes its local state from
 * the latest `initial` prop — no separate "reset on open" plumbing needed
 * in the parent, unlike the pre-extraction org-only version of this form.
 *
 * `workflowsUsed`/`projectsUsed` are optional: only the org caller has
 * real usage counters to preview the DB triggers' "lower limit, existing
 * rows stay" warning against (see planLimitWarning.ts's own doc comment on
 * why that warning only applies to workflow/project, not copilot/rows —
 * those two are app-level pre-checks, not INSERT-blocking triggers, so
 * there's no equivalent "existing X stay" framing). The individual-user
 * caller has no usage rollup at all yet and simply omits both.
 */
export default function PlanOverrideForm({
  plans,
  initial,
  workflowsUsed,
  projectsUsed,
  isPending,
  error,
  onSave,
  onCancel,
}: {
  plans: ConsolePlan[];
  initial: ConsolePlanOverrideFields;
  workflowsUsed?: number;
  projectsUsed?: number;
  isPending: boolean;
  error: string | null;
  onSave: (values: ConsolePlanOverrideFields & { reason: string }) => void;
  onCancel: () => void;
}) {
  const [planId, setPlanId] = useState(initial.planId);
  const [workflowLimitOverrideSet, setWorkflowLimitOverrideSet] = useState(initial.workflowLimitOverrideSet);
  const [workflowLimitOverride, setWorkflowLimitOverride] = useState(
    initial.workflowLimitOverride === null ? '' : String(initial.workflowLimitOverride),
  );
  const [projectLimitOverrideSet, setProjectLimitOverrideSet] = useState(initial.projectLimitOverrideSet);
  const [projectLimitOverride, setProjectLimitOverride] = useState(
    initial.projectLimitOverride === null ? '' : String(initial.projectLimitOverride),
  );
  const [grantPlanId, setGrantPlanId] = useState(initial.grantPlanId ?? '');
  const [grantCopilotOverrideSet, setGrantCopilotOverrideSet] = useState(
    initial.grantCopilotActionsPerMonthOverrideSet,
  );
  const [grantCopilotOverride, setGrantCopilotOverride] = useState(
    initial.grantCopilotActionsPerMonthOverride === null ? '' : String(initial.grantCopilotActionsPerMonthOverride),
  );
  const [grantRowsOverrideSet, setGrantRowsOverrideSet] = useState(initial.grantRowsPerMonthOverrideSet);
  const [grantRowsOverride, setGrantRowsOverride] = useState(
    initial.grantRowsPerMonthOverride === null ? '' : String(initial.grantRowsPerMonthOverride),
  );
  const [grantExpiresAt, setGrantExpiresAt] = useState(
    initial.grantExpiresAt ? initial.grantExpiresAt.slice(0, 10) : '',
  );
  const [reason, setReason] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const selectedPlan = plans.find((p) => p.id === planId);

  // Live preview while typing, workflow/project only — see doc comment above.
  const trimmedWorkflowPreview = workflowLimitOverride.trim();
  const parsedWorkflowPreview =
    trimmedWorkflowPreview && Number.isInteger(Number(trimmedWorkflowPreview)) && Number(trimmedWorkflowPreview) > 0
      ? Number(trimmedWorkflowPreview)
      : null;
  const effectiveWorkflowLimitPreview = workflowLimitOverrideSet
    ? parsedWorkflowPreview
    : selectedPlan?.workflowLimit ?? null;
  const workflowLowerLimitWarning =
    workflowsUsed === undefined ? null : formatLowerLimitWarning(workflowsUsed, effectiveWorkflowLimitPreview, 'workflows');

  const trimmedProjectPreview = projectLimitOverride.trim();
  const parsedProjectPreview =
    trimmedProjectPreview && Number.isInteger(Number(trimmedProjectPreview)) && Number(trimmedProjectPreview) > 0
      ? Number(trimmedProjectPreview)
      : null;
  const effectiveProjectLimitPreview = projectLimitOverrideSet ? parsedProjectPreview : selectedPlan?.projectLimit ?? null;
  const projectLowerLimitWarning =
    projectsUsed === undefined ? null : formatLowerLimitWarning(projectsUsed, effectiveProjectLimitPreview, 'projects');

  function parseOverride(set: boolean, raw: string, label: string): { ok: true; value: number | null } | { ok: false; error: string } {
    if (!set) return { ok: true, value: null };
    const trimmed = raw.trim();
    if (!trimmed) return { ok: true, value: null };
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n <= 0) {
      return { ok: false, error: `${label} override must be a positive whole number, or blank for unlimited.` };
    }
    return { ok: true, value: n };
  }

  function handleSave() {
    const workflow = parseOverride(workflowLimitOverrideSet, workflowLimitOverride, 'Workflow limit');
    if (!workflow.ok) {
      setLocalError(workflow.error);
      return;
    }
    const project = parseOverride(projectLimitOverrideSet, projectLimitOverride, 'Project limit');
    if (!project.ok) {
      setLocalError(project.error);
      return;
    }
    const copilot = parseOverride(grantCopilotOverrideSet, grantCopilotOverride, 'Grant copilot actions/mo');
    if (!copilot.ok) {
      setLocalError(copilot.error);
      return;
    }
    const rows = parseOverride(grantRowsOverrideSet, grantRowsOverride, 'Grant rows/mo');
    if (!rows.ok) {
      setLocalError(rows.error);
      return;
    }
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setLocalError('Reason is required.');
      return;
    }

    setLocalError(null);
    onSave({
      planId,
      workflowLimitOverrideSet,
      workflowLimitOverride: workflow.value,
      projectLimitOverrideSet,
      projectLimitOverride: project.value,
      grantPlanId: grantPlanId || null,
      grantCopilotActionsPerMonthOverrideSet: grantCopilotOverrideSet,
      grantCopilotActionsPerMonthOverride: copilot.value,
      grantRowsPerMonthOverrideSet: grantRowsOverrideSet,
      grantRowsPerMonthOverride: rows.value,
      grantExpiresAt: grantExpiresAt ? new Date(`${grantExpiresAt}T00:00:00.000Z`).toISOString() : null,
      reason: trimmedReason,
    });
  }

  const displayedError = localError ?? error;

  return (
    <div style={consolePlanFormStyle}>
      <div style={consolePlanFieldStyle}>
        <label htmlFor="console-plan-id" style={consolePlanFieldLabelStyle}>
          Plan
        </label>
        <select
          id="console-plan-id"
          value={planId}
          onChange={(e) => setPlanId(e.target.value)}
          disabled={isPending}
          style={consolePlanInputStyle}
        >
          {plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <div style={consolePlanFieldStyle}>
        <label htmlFor="console-workflow-limit" style={consolePlanFieldLabelStyle}>
          Workflow limit override
        </label>
        <input
          id="console-workflow-limit"
          value={workflowLimitOverride}
          onChange={(e) => setWorkflowLimitOverride(e.target.value)}
          placeholder="Unlimited"
          inputMode="numeric"
          disabled={isPending || !workflowLimitOverrideSet}
          style={consolePlanInputStyle}
        />
        <div style={consolePlanOverrideRowStyle}>
          <input
            id="console-workflow-limit-override-set"
            type="checkbox"
            checked={workflowLimitOverrideSet}
            onChange={(e) => setWorkflowLimitOverrideSet(e.target.checked)}
            disabled={isPending}
          />
          <label htmlFor="console-workflow-limit-override-set" style={consolePlanOverrideLabelStyle}>
            {workflowLimitOverrideSet
              ? 'Clear override'
              : `Override (plan default: ${selectedPlan?.workflowLimit === null || selectedPlan?.workflowLimit === undefined ? 'Unlimited' : selectedPlan.workflowLimit})`}
          </label>
        </div>
      </div>

      <div style={consolePlanFieldStyle}>
        <label htmlFor="console-project-limit" style={consolePlanFieldLabelStyle}>
          Project limit override
        </label>
        <input
          id="console-project-limit"
          value={projectLimitOverride}
          onChange={(e) => setProjectLimitOverride(e.target.value)}
          placeholder="Unlimited"
          inputMode="numeric"
          disabled={isPending || !projectLimitOverrideSet}
          style={consolePlanInputStyle}
        />
        <div style={consolePlanOverrideRowStyle}>
          <input
            id="console-project-limit-override-set"
            type="checkbox"
            checked={projectLimitOverrideSet}
            onChange={(e) => setProjectLimitOverrideSet(e.target.checked)}
            disabled={isPending}
          />
          <label htmlFor="console-project-limit-override-set" style={consolePlanOverrideLabelStyle}>
            {projectLimitOverrideSet
              ? 'Clear override'
              : `Override (plan default: ${selectedPlan?.projectLimit === null || selectedPlan?.projectLimit === undefined ? 'Unlimited' : selectedPlan.projectLimit})`}
          </label>
        </div>
      </div>

      <div style={consolePlanFieldStyle}>
        <label htmlFor="console-grant-plan-id" style={consolePlanFieldLabelStyle}>
          Grant plan (optional, temporary)
        </label>
        <select
          id="console-grant-plan-id"
          value={grantPlanId}
          onChange={(e) => setGrantPlanId(e.target.value)}
          disabled={isPending}
          style={consolePlanInputStyle}
        >
          <option value="">None — stay on base plan</option>
          {plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <div style={consolePlanFieldStyle}>
        <label htmlFor="console-copilot-limit" style={consolePlanFieldLabelStyle}>
          Grant copilot actions/mo override
        </label>
        <input
          id="console-copilot-limit"
          value={grantCopilotOverride}
          onChange={(e) => setGrantCopilotOverride(e.target.value)}
          placeholder="Unlimited"
          inputMode="numeric"
          disabled={isPending || !grantCopilotOverrideSet}
          style={consolePlanInputStyle}
        />
        <div style={consolePlanOverrideRowStyle}>
          <input
            id="console-copilot-limit-override-set"
            type="checkbox"
            checked={grantCopilotOverrideSet}
            onChange={(e) => setGrantCopilotOverrideSet(e.target.checked)}
            disabled={isPending}
          />
          <label htmlFor="console-copilot-limit-override-set" style={consolePlanOverrideLabelStyle}>
            {grantCopilotOverrideSet
              ? 'Clear override'
              : `Override (plan default: ${selectedPlan?.copilotActionsPerMonth === null || selectedPlan?.copilotActionsPerMonth === undefined ? 'Unlimited' : selectedPlan.copilotActionsPerMonth})`}
          </label>
        </div>
      </div>

      <div style={consolePlanFieldStyle}>
        <label htmlFor="console-rows-limit" style={consolePlanFieldLabelStyle}>
          Grant rows/mo override
        </label>
        <input
          id="console-rows-limit"
          value={grantRowsOverride}
          onChange={(e) => setGrantRowsOverride(e.target.value)}
          placeholder="Unlimited"
          inputMode="numeric"
          disabled={isPending || !grantRowsOverrideSet}
          style={consolePlanInputStyle}
        />
        <div style={consolePlanOverrideRowStyle}>
          <input
            id="console-rows-limit-override-set"
            type="checkbox"
            checked={grantRowsOverrideSet}
            onChange={(e) => setGrantRowsOverrideSet(e.target.checked)}
            disabled={isPending}
          />
          <label htmlFor="console-rows-limit-override-set" style={consolePlanOverrideLabelStyle}>
            {grantRowsOverrideSet
              ? 'Clear override'
              : `Override (plan default: ${selectedPlan?.rowsPerMonth === null || selectedPlan?.rowsPerMonth === undefined ? 'Unlimited' : selectedPlan.rowsPerMonth})`}
          </label>
        </div>
      </div>

      <div style={consolePlanFieldStyle}>
        <label htmlFor="console-plan-expires-at" style={consolePlanFieldLabelStyle}>
          Grant expiry (optional)
        </label>
        <input
          id="console-plan-expires-at"
          type="date"
          value={grantExpiresAt}
          onChange={(e) => setGrantExpiresAt(e.target.value)}
          disabled={isPending}
          style={consolePlanInputStyle}
        />
        <span style={consolePlanOverrideLabelStyle}>
          When past, the grant above reverts to the base plan selected at the top — never to Free.
        </span>
      </div>

      <div style={{ ...consolePlanFieldStyle, flex: '1 1 100%' }}>
        <label htmlFor="console-plan-reason" style={consolePlanFieldLabelStyle}>
          Reason
        </label>
        <textarea
          id="console-plan-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={isPending}
          style={consoleSuspendTextareaStyle}
          placeholder="Why is this plan/limit changing? (required, kept in the audit log)"
        />
      </div>

      <div style={consolePlanFormActionsStyle}>
        <button type="button" onClick={handleSave} disabled={isPending} style={consolePrimaryBtnStyle}>
          {isPending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onCancel} disabled={isPending} style={consoleGhostBtnStyle}>
          Cancel
        </button>
      </div>

      {!displayedError && workflowLowerLimitWarning && (
        <span style={consolePlanFormWarningStyle}>{workflowLowerLimitWarning}</span>
      )}
      {!displayedError && projectLowerLimitWarning && <span style={consolePlanFormWarningStyle}>{projectLowerLimitWarning}</span>}
      {displayedError && <span style={consolePlanFormErrorStyle}>{displayedError}</span>}
    </div>
  );
}
