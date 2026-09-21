import { useMemo } from 'react';
import { conditionsToExpr, exprToConditions } from '@nia/schemas';
import type { AggregateFn, AggregationSpec, Expr, FilterCondition, FilterOperator, TransformStep } from '@nia/schemas';
import { FieldSelect, OnFailureSelect, OPERATORS, addStepBtnStyle, coerceValue, inputStyle, removeBtnStyle, rowStyle } from './shared';

const AGGREGATE_FNS: { value: AggregateFn; label: string }[] = [
  { value: 'count', label: 'count' },
  { value: 'count_field', label: 'count (field)' },
  { value: 'count_distinct', label: 'count distinct' },
  { value: 'sum', label: 'sum' },
  { value: 'avg', label: 'avg' },
  { value: 'min', label: 'min' },
  { value: 'max', label: 'max' },
];

/**
 * Phase 6 Block 6 (d): aggregate step editor. GroupBy is a checkbox
 * multi-select over upstream fields (`[]` is a valid, common "whole-table
 * aggregate" choice, not an error state — see nodeConfig.ts's AggregateStep
 * comment). Each aggregation row's `alias` is live-validated against every
 * other alias AND every groupBy field name (ruling 4, mirrored from
 * checks.ts's checkConfig so the drawer surfaces the same collision before a
 * check run ever has to). The having builder's field dropdown is restricted
 * to exactly {groupBy fields} ∪ {aggregation aliases} — ruling 2 — so it's
 * structurally impossible to build a having condition against a raw
 * upstream field from this UI (checks.ts still re-validates server-side for
 * configs saved before this restriction existed, or hand-edited).
 */
export function AggregateStepEditor({
  step,
  fields,
  onChange,
}: {
  step: Extract<TransformStep, { kind: 'aggregate' }>;
  fields: string[];
  onChange: (next: Extract<TransformStep, { kind: 'aggregate' }>) => void;
}) {
  const outputNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const name of step.groupBy) counts.set(name, (counts.get(name) ?? 0) + 1);
    for (const agg of step.aggregations) if (agg.alias) counts.set(agg.alias, (counts.get(agg.alias) ?? 0) + 1);
    return counts;
  }, [step.groupBy, step.aggregations]);

  const havingFieldOptions = useMemo(
    () => [...step.groupBy, ...step.aggregations.map((a) => a.alias).filter(Boolean)],
    [step.groupBy, step.aggregations],
  );

  // Phase 8b-1: `step.having` is an `Expr | undefined`, not a
  // `FilterCondition[] | undefined`. This editor still only authors flat
  // AND-of-comparisons/predicate trees; unpack via `exprToConditions`
  // (`undefined` -> `[]`, same as the old "no having" state) and fall back
  // to a read-only notice if the loaded expr isn't representable that way.
  const havingConditions = useMemo(
    () => (step.having === undefined ? [] : exprToConditions(step.having)),
    [step.having],
  );

  function packHaving(conditions: FilterCondition[]): Expr | undefined {
    return conditions.length > 0 ? conditionsToExpr(conditions) : undefined;
  }

  function toggleGroupBy(field: string) {
    const next = step.groupBy.includes(field) ? step.groupBy.filter((f) => f !== field) : [...step.groupBy, field];
    onChange({ ...step, groupBy: next });
  }

  function updateAggregation(i: number, patch: Partial<AggregationSpec>) {
    const next = step.aggregations.slice();
    const merged: AggregationSpec = { ...next[i]!, ...patch };
    if (merged.fn === 'count') merged.field = null;
    next[i] = merged;
    onChange({ ...step, aggregations: next });
  }

  function addAggregation() {
    onChange({ ...step, aggregations: [...step.aggregations, { fn: 'count', field: null, alias: '' }] });
  }

  function removeAggregation(i: number) {
    onChange({ ...step, aggregations: step.aggregations.filter((_, idx) => idx !== i) });
  }

  function updateHaving(i: number, patch: Partial<FilterCondition>) {
    const having = havingConditions!.slice();
    const merged: FilterCondition = { ...having[i]!, ...patch };
    having[i] = merged;
    onChange({ ...step, having: packHaving(having) });
  }

  function addHaving() {
    onChange({
      ...step,
      having: packHaving([...havingConditions!, { field: havingFieldOptions[0] ?? '', operator: 'eq', value: '' }]),
    });
  }

  function removeHaving(i: number) {
    onChange({ ...step, having: packHaving(havingConditions!.filter((_, idx) => idx !== i)) });
  }

  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--ink4)', marginBottom: 4 }}>Group by (none = whole-table aggregate)</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
        {fields.length === 0 && <div style={{ fontSize: 11.5, color: 'var(--ink4)' }}>No upstream fields yet — connect a source.</div>}
        {fields.map((f) => (
          <label key={f} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5, fontFamily: 'var(--font-data)', color: 'var(--ink)' }}>
            <input type="checkbox" checked={step.groupBy.includes(f)} onChange={() => toggleGroupBy(f)} />
            {f}
          </label>
        ))}
      </div>

      <div style={{ fontSize: 11, color: 'var(--ink4)', marginBottom: 4 }}>Aggregations</div>
      {step.aggregations.map((agg, i) => {
        const collides = agg.alias !== '' && (outputNames.get(agg.alias) ?? 0) > 1;
        return (
          <div key={i} style={rowStyle}>
            <select
              value={agg.fn}
              onChange={(e) => updateAggregation(i, { fn: e.target.value as AggregateFn })}
              style={{ ...inputStyle, width: 120 }}
            >
              {AGGREGATE_FNS.map((fn) => (
                <option key={fn.value} value={fn.value}>
                  {fn.label}
                </option>
              ))}
            </select>
            {agg.fn !== 'count' ? (
              <FieldSelect value={agg.field ?? ''} onChange={(v) => updateAggregation(i, { field: v })} fields={fields} />
            ) : (
              <span style={{ flex: 1, fontSize: 11.5, color: 'var(--ink4)' }}>*</span>
            )}
            <input
              value={agg.alias}
              onChange={(e) => updateAggregation(i, { alias: e.target.value })}
              placeholder="output name"
              style={{ ...inputStyle, width: 110, fontFamily: 'var(--font-data)', borderColor: collides ? 'var(--bad)' : 'var(--line2)' }}
            />
            <button type="button" aria-label="Remove aggregation" onClick={() => removeAggregation(i)} style={removeBtnStyle}>
              {'\u2715'}
            </button>
          </div>
        );
      })}
      {step.aggregations.some((agg) => agg.alias !== '' && (outputNames.get(agg.alias) ?? 0) > 1) && (
        <div style={{ fontSize: 11.5, color: 'var(--bad)', marginBottom: 6 }}>
          Two outputs share the same name — every aggregation alias and groupBy field must be unique.
        </div>
      )}
      <button type="button" onClick={addAggregation} style={{ ...addStepBtnStyle, marginBottom: 12 }}>
        + Aggregation
      </button>

      <div style={{ fontSize: 11, color: 'var(--ink4)', marginBottom: 4 }}>
        Having (filters on the aggregated output — alias or groupBy field only)
      </div>
      {havingConditions === null ? (
        <div style={{ fontSize: 12, color: 'var(--ink4)', fontStyle: 'italic', marginBottom: 6 }}>
          This having expression is too complex for this editor (built by hand or by Copilot). It will keep running
          as-is; edit it via the expression source to change it.
        </div>
      ) : (
        <>
          {havingConditions.map((cond, i) => (
            <div key={i} style={rowStyle}>
              <select
                value={cond.field}
                onChange={(e) => updateHaving(i, { field: e.target.value })}
                style={{ ...inputStyle, flex: 1 }}
              >
                <option value="" disabled>
                  Select output…
                </option>
                {!havingFieldOptions.includes(cond.field) && cond.field && <option value={cond.field}>{cond.field}</option>}
                {havingFieldOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <select
                value={cond.operator}
                onChange={(e) => updateHaving(i, { operator: e.target.value as FilterOperator })}
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
                  onChange={(e) => updateHaving(i, { value: coerceValue(e.target.value) })}
                  placeholder="value"
                  style={{ ...inputStyle, width: 90, fontFamily: 'var(--font-data)' }}
                />
              )}
              <button type="button" aria-label="Remove having condition" onClick={() => removeHaving(i)} style={removeBtnStyle}>
                {'\u2715'}
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addHaving}
            disabled={havingFieldOptions.length === 0}
            style={{ ...addStepBtnStyle, opacity: havingFieldOptions.length === 0 ? 0.5 : 1 }}
          >
            + Having condition
          </button>
        </>
      )}
      <div style={{ marginTop: 12 }}>
        <OnFailureSelect value={step.onFailure} onChange={(v) => onChange({ ...step, onFailure: v })} />
      </div>
    </div>
  );
}
