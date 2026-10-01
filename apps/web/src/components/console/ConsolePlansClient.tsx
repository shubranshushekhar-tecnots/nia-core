'use client';

import { useState, useTransition } from 'react';
import type { ConsolePlan, ConsolePlanUpdateWarning } from '@/lib/api/consoleServer';
import { updatePlanAction } from '@/lib/console/actions';
import {
  consoleColActionsStyle,
  consoleColRunsStyle,
  consoleContentStyle,
  consoleEmptyStyle,
  consoleGhostBtnStyle,
  consoleHeaderRowStyle,
  consoleHeaderSubStyle,
  consoleHeaderTitleColStyle,
  consoleHeaderTitleStyle,
  consolePlanFieldLabelStyle,
  consolePlanFieldStyle,
  consolePlanFormActionsStyle,
  consolePlanFormErrorStyle,
  consolePlanFormStyle,
  consolePlanInputStyle,
  consolePrimaryBtnStyle,
  consoleRowNumberStyle,
  consoleRowStyle,
  consoleTableHeadRowStyle,
  consoleTableStyle,
  consoleWarningItemStyle,
  consoleWarningsListStyle,
} from './styles';

/**
 * Console redesign plan's Slice 7 — Plans page. Catalog view of
 * public.plans (GET /console/plans, already existed for the Org Detail
 * dropdown) plus an inline edit form per row (same "no modal, replace the
 * row in place" convention as ConsoleOrgDetailClient's plan-edit form) that
 * submits to the new PATCH /console/plans/:planId. A successful save can
 * come back with non-empty `warnings` — orgs whose usage already meets or
 * exceeds a newly-lowered limit — which render under that row without
 * undoing the save, per the plan's "warn, don't block" instruction.
 */
export default function ConsolePlansClient({ initialPlans }: { initialPlans: ConsolePlan[] }) {
  const [plans, setPlans] = useState(initialPlans);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [warningsByPlan, setWarningsByPlan] = useState<Record<string, ConsolePlanUpdateWarning[]>>({});

  return (
    <div style={consoleContentStyle}>
      <div style={consoleHeaderRowStyle}>
        <div style={consoleHeaderTitleColStyle}>
          <span style={consoleHeaderTitleStyle}>Plans</span>
          <span style={consoleHeaderSubStyle}>{plans.length} plans in the catalog</span>
        </div>
      </div>

      <div style={consoleTableStyle}>
        <div style={consoleTableHeadRowStyle}>
          <span style={{ flex: '2 1 160px', minWidth: 120 }}>Plan</span>
          <span style={consoleColRunsStyle}>Projects</span>
          <span style={consoleColRunsStyle}>Workflows</span>
          <span style={consoleColRunsStyle}>Rows/mo</span>
          <span style={consoleColRunsStyle}>Copilot/mo</span>
          <span style={consoleColActionsStyle}></span>
        </div>

        {plans.length === 0 && <div style={consoleEmptyStyle}>No plans.</div>}

        {plans.map((plan) =>
          editingId === plan.id ? (
            <PlanEditRow
              key={plan.id}
              plan={plan}
              warnings={warningsByPlan[plan.id] ?? []}
              onCancel={() => setEditingId(null)}
              onSaved={(updated, warnings) => {
                setPlans((prev) => prev.map((p) => (p.id === plan.id ? { ...p, ...updated } : p)));
                setWarningsByPlan((prev) => ({ ...prev, [plan.id]: warnings }));
                setEditingId(null);
              }}
            />
          ) : (
            <div key={plan.id} style={consoleRowStyle}>
              <span style={{ flex: '2 1 160px', minWidth: 120, fontSize: 13, color: 'var(--c-text)' }}>{plan.name}</span>
              <span style={consoleRowNumberStyle}>{plan.projectLimit ?? '\u221E'}</span>
              <span style={consoleRowNumberStyle}>{plan.workflowLimit ?? '\u221E'}</span>
              <span style={consoleRowNumberStyle}>{plan.rowsPerMonth ?? '\u221E'}</span>
              <span style={consoleRowNumberStyle}>{plan.copilotActionsPerMonth ?? '\u221E'}</span>
              <span style={consoleColActionsStyle}>
                <button
                  type="button"
                  onClick={() => {
                    setWarningsByPlan((prev) => ({ ...prev, [plan.id]: [] }));
                    setEditingId(plan.id);
                  }}
                  style={consoleGhostBtnStyle}
                >
                  Edit
                </button>
              </span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

function PlanEditRow({
  plan,
  warnings,
  onCancel,
  onSaved,
}: {
  plan: ConsolePlan;
  warnings: ConsolePlanUpdateWarning[];
  onCancel: () => void;
  onSaved: (
    updated: {
      projectLimit: number | null;
      workflowLimit: number | null;
      rowsPerMonth: number | null;
      copilotActionsPerMonth: number | null;
    },
    warnings: ConsolePlanUpdateWarning[],
  ) => void;
}) {
  const [projectLimit, setProjectLimit] = useState(plan.projectLimit === null ? '' : String(plan.projectLimit));
  const [workflowLimit, setWorkflowLimit] = useState(plan.workflowLimit === null ? '' : String(plan.workflowLimit));
  const [rowsPerMonth, setRowsPerMonth] = useState(plan.rowsPerMonth === null ? '' : String(plan.rowsPerMonth));
  const [copilotActionsPerMonth, setCopilotActionsPerMonth] = useState(
    plan.copilotActionsPerMonth === null ? '' : String(plan.copilotActionsPerMonth),
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function parseLimit(label: string, raw: string): number | null | undefined {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n <= 0) {
      setFormError(`${label} must be a positive whole number, or blank for unlimited.`);
      return undefined;
    }
    return n;
  }

  function handleSave() {
    setFormError(null);
    const parsedProjectLimit = parseLimit('Project limit', projectLimit);
    if (parsedProjectLimit === undefined) return;
    const parsedWorkflowLimit = parseLimit('Workflow limit', workflowLimit);
    if (parsedWorkflowLimit === undefined) return;
    const parsedRowsPerMonth = parseLimit('Rows/mo', rowsPerMonth);
    if (parsedRowsPerMonth === undefined) return;
    const parsedCopilotActionsPerMonth = parseLimit('Copilot/mo', copilotActionsPerMonth);
    if (parsedCopilotActionsPerMonth === undefined) return;

    startTransition(async () => {
      const result = await updatePlanAction(
        plan.id,
        parsedProjectLimit,
        parsedWorkflowLimit,
        parsedRowsPerMonth,
        parsedCopilotActionsPerMonth,
      );
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      onSaved(
        {
          projectLimit: result.projectLimit,
          workflowLimit: result.workflowLimit,
          rowsPerMonth: result.rowsPerMonth,
          copilotActionsPerMonth: result.copilotActionsPerMonth,
        },
        result.warnings,
      );
    });
  }

  return (
    <div style={consolePlanFormStyle}>
      <span style={{ flex: '1 1 100%', fontSize: 13, fontWeight: 600, color: 'var(--c-text)' }}>{plan.name}</span>

      <div style={consolePlanFieldStyle}>
        <label style={consolePlanFieldLabelStyle} htmlFor={`project-limit-${plan.id}`}>
          Project limit
        </label>
        <input
          id={`project-limit-${plan.id}`}
          style={consolePlanInputStyle}
          value={projectLimit}
          onChange={(e) => setProjectLimit(e.target.value)}
          placeholder="Unlimited"
        />
      </div>

      <div style={consolePlanFieldStyle}>
        <label style={consolePlanFieldLabelStyle} htmlFor={`workflow-limit-${plan.id}`}>
          Workflow limit
        </label>
        <input
          id={`workflow-limit-${plan.id}`}
          style={consolePlanInputStyle}
          value={workflowLimit}
          onChange={(e) => setWorkflowLimit(e.target.value)}
          placeholder="Unlimited"
        />
      </div>

      <div style={consolePlanFieldStyle}>
        <label style={consolePlanFieldLabelStyle} htmlFor={`rows-per-month-${plan.id}`}>
          Rows/mo
        </label>
        <input
          id={`rows-per-month-${plan.id}`}
          style={consolePlanInputStyle}
          value={rowsPerMonth}
          onChange={(e) => setRowsPerMonth(e.target.value)}
          placeholder="Unlimited"
        />
      </div>

      <div style={consolePlanFieldStyle}>
        <label style={consolePlanFieldLabelStyle} htmlFor={`copilot-actions-per-month-${plan.id}`}>
          Copilot/mo
        </label>
        <input
          id={`copilot-actions-per-month-${plan.id}`}
          style={consolePlanInputStyle}
          value={copilotActionsPerMonth}
          onChange={(e) => setCopilotActionsPerMonth(e.target.value)}
          placeholder="Unlimited"
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

      {formError && <span style={consolePlanFormErrorStyle}>{formError}</span>}

      {warnings.length > 0 && (
        <div style={consoleWarningsListStyle}>
          {warnings.map((w, i) => (
            <span key={`${w.orgId}-${w.limit}-${i}`} style={consoleWarningItemStyle}>
              {w.orgName}: {w.limit.replace(/_/g, ' ')} usage is {w.currentUsage}, now above the new limit of{' '}
              {w.newLimit}.
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
