'use client';

import { useState } from 'react';
import type { ConsolePlan } from '@/lib/api/consoleServer';
import {
  consoleGhostBtnStyle,
  consolePlanFieldLabelStyle,
  consolePlanFieldStyle,
  consolePlanFormActionsStyle,
  consolePlanFormErrorStyle,
  consolePlanFormStyle,
  consolePlanInputStyle,
  consolePlanOverrideLabelStyle,
  consolePrimaryBtnStyle,
} from './styles';

/**
 * Email Phase 3 — the smaller, purpose-built approve form named in the
 * plan (distinct from PlanOverrideForm.tsx's full tri-state workflow/
 * project-limit-override form): there's no org/user yet to preview usage
 * against pre-signup, so this only carries a base plan (optional — leave
 * unset to let the new account land on the catalog default), an optional
 * temporary grant plan + expiry (same semantics as PlanOverrideForm's
 * grant fields), and the confirm/cancel actions. Mounted inline per-row by
 * ConsoleAccessRequestsClient, same "expand in place, not a modal"
 * convention as ConsoleOrgDetailClient's suspend form.
 */
export default function AccessRequestApproveForm({
  plans,
  isPending,
  error,
  onApprove,
  onCancel,
}: {
  plans: ConsolePlan[];
  isPending: boolean;
  error: string | null;
  onApprove: (values: { planId?: string; grantPlanId: string | null; grantExpiresAt: string | null }) => void;
  onCancel: () => void;
}) {
  const [planId, setPlanId] = useState('');
  const [grantPlanId, setGrantPlanId] = useState('');
  const [grantExpiresAt, setGrantExpiresAt] = useState('');

  function handleApprove() {
    onApprove({
      planId: planId || undefined,
      grantPlanId: grantPlanId || null,
      grantExpiresAt: grantExpiresAt ? new Date(`${grantExpiresAt}T00:00:00.000Z`).toISOString() : null,
    });
  }

  return (
    <div style={consolePlanFormStyle}>
      <div style={consolePlanFieldStyle}>
        <label htmlFor="console-access-request-plan" style={consolePlanFieldLabelStyle}>
          Plan (optional)
        </label>
        <select
          id="console-access-request-plan"
          value={planId}
          onChange={(e) => setPlanId(e.target.value)}
          disabled={isPending}
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
        <label htmlFor="console-access-request-grant-plan" style={consolePlanFieldLabelStyle}>
          Grant plan (optional, temporary)
        </label>
        <select
          id="console-access-request-grant-plan"
          value={grantPlanId}
          onChange={(e) => setGrantPlanId(e.target.value)}
          disabled={isPending}
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
        <label htmlFor="console-access-request-grant-expires" style={consolePlanFieldLabelStyle}>
          Grant expiry (optional)
        </label>
        <input
          id="console-access-request-grant-expires"
          type="date"
          value={grantExpiresAt}
          onChange={(e) => setGrantExpiresAt(e.target.value)}
          disabled={isPending || !grantPlanId}
          style={consolePlanInputStyle}
        />
        <span style={consolePlanOverrideLabelStyle}>When past, the grant reverts to the base plan above.</span>
      </div>

      <div style={consolePlanFormActionsStyle}>
        <button type="button" onClick={handleApprove} disabled={isPending} style={consolePrimaryBtnStyle}>
          {isPending ? 'Approving…' : 'Confirm approve'}
        </button>
        <button type="button" onClick={onCancel} disabled={isPending} style={consoleGhostBtnStyle}>
          Cancel
        </button>
      </div>

      {error && <span style={consolePlanFormErrorStyle}>{error}</span>}
    </div>
  );
}
