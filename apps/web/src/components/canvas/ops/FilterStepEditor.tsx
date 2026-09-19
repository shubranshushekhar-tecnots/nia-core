import { useMemo } from 'react';
import { conditionsToExpr, exprToConditions } from '@nia/schemas';
import type { FilterCondition, FilterOperator, TransformStep } from '@nia/schemas';
import { FieldSelect, OPERATORS, coerceValue, inputStyle, removeBtnStyle, rowStyle } from './shared';

/**
 * Phase 8b-1: `step.expr` is now an `Expr` tree, not a `FilterCondition[]`
 * array. This editor still only *authors* flat AND-of-comparisons/predicate
 * trees (via `conditionsToExpr`), same as before — it unpacks whatever
 * `expr` it's handed back into rows via `exprToConditions` (the inverse).
 * If the loaded `expr` isn't representable that way (e.g. hand-authored or
 * Copilot-proposed `or`/`conditional` trees), `exprToConditions` returns
 * `null` and this falls back to a read-only notice rather than risk
 * silently discarding part of the condition on the next edit — same
 * pattern as `parseNodeConfig`'s `unrecognized: true` handling.
 */
export function FilterStepEditor({
  step,
  fields,
  onChange,
}: {
  step: Extract<TransformStep, { kind: 'filter' }>;
  fields: string[];
  onChange: (next: Extract<TransformStep, { kind: 'filter' }>) => void;
}) {
  const conditions = useMemo(() => exprToConditions(step.expr), [step.expr]);

  if (conditions === null) {
    return (
      <div style={{ fontSize: 12, color: 'var(--ink4)', fontStyle: 'italic' }}>
        This filter&apos;s expression is too complex for this editor (built by hand or by Copilot). It will keep
        running as-is; edit it via the expression source to change it.
      </div>
    );
  }

  function updateCondition(i: number, patch: Partial<FilterCondition>) {
    const conds = conditions!;
    const next = conds.slice();
    const merged: FilterCondition = { ...next[i]!, ...patch };
    next[i] = merged;
    onChange({ ...step, expr: conditionsToExpr(next) });
  }

  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--ink4)', marginBottom: 6 }}>All conditions must match (AND).</div>
      {conditions.map((cond, i) => (
        <div key={i} style={rowStyle}>
          <FieldSelect value={cond.field} onChange={(v) => updateCondition(i, { field: v })} fields={fields} />
          <select
            value={cond.operator}
            onChange={(e) => updateCondition(i, { operator: e.target.value as FilterOperator })}
            style={{ ...inputStyle, width: 110 }}
          >
            {OPERATORS.map((op) => (
              <option key={op.value} value={op.value}>
                {op.label}
              </option>
            ))}
          </select>
          {cond.operator !== 'is_null' && cond.operator !== 'is_not_null' && (
            <input
              value={String(cond.value ?? '')}
              onChange={(e) => updateCondition(i, { value: coerceValue(e.target.value) })}
              placeholder="value"
              style={{ ...inputStyle, width: 90, fontFamily: 'var(--font-data)' }}
            />
          )}
          <button
            type="button"
            aria-label="Remove condition"
            onClick={() => onChange({ ...step, expr: conditionsToExpr(conditions.filter((_, idx) => idx !== i)) })}
            style={removeBtnStyle}
          >
            {'\u2715'}
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          onChange({ ...step, expr: conditionsToExpr([...conditions, { field: fields[0] ?? '', operator: 'eq', value: '' }]) })
        }
        style={{ fontSize: 12, border: '1px dashed var(--line2)', background: 'none', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', color: 'var(--ink3)' }}
      >
        + Condition
      </button>
    </div>
  );
}
