'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  compilePushdown,
  manifestDialect,
  parseExpression,
  stringifyExpression,
  type TransformConfig,
  type TransformStep,
  type FilterCondition,
  type FilterOperator,
  type AggregateFn,
  type AggregationSpec,
} from '@nia/schemas';
import { getConnectionSchema } from '@/lib/api/connectionsClient';

/**
 * Task 2's declarative transform editor (filter / computed field / drop
 * fields) + Task 3's pushdown transparency panel, colocated since both
 * operate on the same TransformConfig + resolved dialect. Field
 * suggestions come from the immediate upstream source's introspected
 * schema (apps/api's GET /connections/:id/schema, cached client-side by
 * TanStack Query) — a union across all of that connection's entities/
 * tables, since source nodes don't have per-entity selection yet (Session
 * 2 scope cut, see nodeConfig.ts).
 */

const OPERATORS: { value: FilterOperator; label: string }[] = [
  { value: 'eq', label: '=' },
  { value: 'neq', label: '≠' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'contains', label: 'contains' },
  { value: 'is_null', label: 'is empty' },
  { value: 'is_not_null', label: 'is not empty' },
];

function coerceValue(raw: string): string | number {
  if (raw.trim() !== '' && !Number.isNaN(Number(raw)) && String(Number(raw)) === raw.trim()) return Number(raw);
  return raw;
}

const rowStyle = { display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' } as const;
const inputStyle = {
  height: 28,
  borderRadius: 6,
  border: '1px solid var(--line2)',
  padding: '0 8px',
  fontSize: 12.5,
  boxSizing: 'border-box',
  color: 'var(--ink)',
  background: 'var(--surface)',
} as const;
const stepCardStyle = {
  border: '1px solid var(--line2)',
  borderRadius: 8,
  padding: 10,
  marginBottom: 10,
  background: 'var(--surface2)',
} as const;
const removeBtnStyle = { border: 'none', background: 'none', color: 'var(--bad)', cursor: 'pointer', fontSize: 12, padding: 0 } as const;

function FieldSelect({
  value,
  onChange,
  fields,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  fields: string[];
  placeholder?: string;
}) {
  if (fields.length === 0) {
    return (
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? 'field name'}
        style={{ ...inputStyle, flex: 1, fontFamily: 'var(--font-data)' }}
      />
    );
  }
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ ...inputStyle, flex: 1 }}>
      <option value="" disabled>
        Select field…
      </option>
      {!fields.includes(value) && value && <option value={value}>{value}</option>}
      {fields.map((f) => (
        <option key={f} value={f}>
          {f}
        </option>
      ))}
    </select>
  );
}

function FilterStepEditor({
  step,
  fields,
  onChange,
}: {
  step: Extract<TransformStep, { kind: 'filter' }>;
  fields: string[];
  onChange: (next: Extract<TransformStep, { kind: 'filter' }>) => void;
}) {
  function updateCondition(i: number, patch: Partial<FilterCondition>) {
    const next = step.conditions.slice();
    const merged: FilterCondition = { ...next[i]!, ...patch };
    next[i] = merged;
    onChange({ ...step, conditions: next });
  }
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--ink4)', marginBottom: 6 }}>All conditions must match (AND).</div>
      {step.conditions.map((cond, i) => (
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
            onClick={() => onChange({ ...step, conditions: step.conditions.filter((_, idx) => idx !== i) })}
            style={removeBtnStyle}
          >
            {'\u2715'}
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          onChange({ ...step, conditions: [...step.conditions, { field: fields[0] ?? '', operator: 'eq', value: '' }] })
        }
        style={{ fontSize: 12, border: '1px dashed var(--line2)', background: 'none', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', color: 'var(--ink3)' }}
      >
        + Condition
      </button>
    </div>
  );
}

function ComputedFieldStepEditor({
  step,
  onChange,
}: {
  step: Extract<TransformStep, { kind: 'computed_field' }>;
  onChange: (next: Extract<TransformStep, { kind: 'computed_field' }>) => void;
}) {
  const [raw, setRaw] = useState(() => stringifyExpression(step.expression));
  const [error, setError] = useState<string | undefined>(undefined);

  function handleExpressionChange(next: string) {
    setRaw(next);
    const parsed = parseExpression(next);
    if (!parsed.ok) {
      setError(parsed.error);
      return; // never saved while invalid — see plan's explicit requirement
    }
    setError(undefined);
    onChange({ ...step, expression: parsed.expr });
  }

  return (
    <div>
      <div style={rowStyle}>
        <span style={{ fontSize: 12, color: 'var(--ink4)', width: 40 }}>Name</span>
        <input
          data-testid="computed-field-name"
          value={step.name}
          onChange={(e) => onChange({ ...step, name: e.target.value })}
          style={{ ...inputStyle, flex: 1 }}
        />
      </div>
      <div style={rowStyle}>
        <span style={{ fontSize: 12, color: 'var(--ink4)', width: 40 }}>Expr</span>
        <input
          data-testid="computed-field-expr"
          value={raw}
          onChange={(e) => handleExpressionChange(e.target.value)}
          placeholder='concat(first_name, " ", last_name)'
          style={{ ...inputStyle, flex: 1, fontFamily: 'var(--font-data)', borderColor: error ? 'var(--bad)' : 'var(--line2)' }}
        />
      </div>
      {error && <div style={{ fontSize: 11.5, color: 'var(--bad)', marginTop: 2 }}>{error}</div>}
      <div style={{ fontSize: 10.5, color: 'var(--ink4)', marginTop: 4 }}>
        Fields, numbers/strings, <span style={{ fontFamily: 'var(--font-data)' }}>+ - * /</span>, concat(), coalesce().
      </div>
    </div>
  );
}

function DropFieldsStepEditor({
  step,
  fields,
  onChange,
}: {
  step: Extract<TransformStep, { kind: 'drop_fields' }>;
  fields: string[];
  onChange: (next: Extract<TransformStep, { kind: 'drop_fields' }>) => void;
}) {
  const known = fields.length > 0 ? fields : step.fields;
  function toggle(field: string) {
    const next = step.fields.includes(field) ? step.fields.filter((f) => f !== field) : [...step.fields, field];
    onChange({ ...step, fields: next });
  }
  return (
    <div>
      {known.length === 0 && <div style={{ fontSize: 11.5, color: 'var(--ink4)' }}>No upstream fields yet — connect a source.</div>}
      {known.map((f) => (
        <label key={f} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, marginBottom: 4, fontFamily: 'var(--font-data)', color: 'var(--ink)' }}>
          <input type="checkbox" checked={step.fields.includes(f)} onChange={() => toggle(f)} />
          {f}
        </label>
      ))}
    </div>
  );
}

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
function AggregateStepEditor({
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
    const having = (step.having ?? []).slice();
    const merged: FilterCondition = { ...having[i]!, ...patch };
    having[i] = merged;
    onChange({ ...step, having });
  }

  function addHaving() {
    onChange({ ...step, having: [...(step.having ?? []), { field: havingFieldOptions[0] ?? '', operator: 'eq', value: '' }] });
  }

  function removeHaving(i: number) {
    const having = (step.having ?? []).filter((_, idx) => idx !== i);
    onChange({ ...step, having: having.length > 0 ? having : undefined });
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
      {(step.having ?? []).map((cond, i) => (
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
    </div>
  );
}

const STEP_LABEL: Record<TransformStep['kind'], string> = {
  filter: 'Filter',
  computed_field: 'Computed field',
  drop_fields: 'Drop fields',
  aggregate: 'Aggregate',
};

export default function TransformEditor({
  config,
  connectionId,
  manifestId,
  onChange,
}: {
  config: TransformConfig;
  connectionId?: string;
  manifestId?: string;
  onChange: (next: TransformConfig) => void;
}) {
  const { data: schema } = useQuery({
    queryKey: ['connection-schema', connectionId],
    queryFn: () => getConnectionSchema(connectionId!),
    enabled: !!connectionId,
    staleTime: 5 * 60_000,
  });

  const fields = useMemo(() => {
    if (!schema) return [];
    const set = new Set<string>();
    for (const entity of schema.entities) for (const f of entity.fields) set.add(f.name);
    return Array.from(set).sort();
  }, [schema]);

  const dialect = manifestDialect(manifestId);
  const plan = useMemo(() => compilePushdown(dialect, config), [dialect, config]);
  const [copied, setCopied] = useState(false);

  function updateStep(i: number, next: TransformStep) {
    const steps = config.steps.slice();
    steps[i] = next;
    onChange({ ...config, steps });
  }
  function removeStep(i: number) {
    onChange({ ...config, steps: config.steps.filter((_, idx) => idx !== i) });
  }
  function addStep(kind: TransformStep['kind']) {
    const step: TransformStep =
      kind === 'filter'
        ? { kind: 'filter', conditions: [] }
        : kind === 'computed_field'
          ? { kind: 'computed_field', name: '', expression: { kind: 'literal', value: '' } }
          : kind === 'drop_fields'
            ? { kind: 'drop_fields', fields: [] }
            : { kind: 'aggregate', groupBy: [], aggregations: [] };
    onChange({ ...config, steps: [...config.steps, step] });
  }

  const fragmentText = useMemo(() => {
    if (!plan.dialectQuery) return null;
    if (plan.dialectQuery.dialect === 'mongo') return JSON.stringify(plan.dialectQuery.pipeline, null, 2);
    const { whereSql, selectSql, isAggregate, groupBySql, havingSql } = plan.dialectQuery;
    // Block 6: when the pushed plan is an aggregate, selectSql is a full
    // REPLACEMENT list (GROUP BY cols + aggregate exprs), not an additive
    // fragment — same distinction pushdown.ts's SqlDialectQuery doc makes.
    return [
      selectSql ? `SELECT ${selectSql}` : null,
      whereSql ? `WHERE ${whereSql}` : null,
      isAggregate && groupBySql ? `GROUP BY ${groupBySql}` : null,
      isAggregate && havingSql ? `HAVING ${havingSql}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  }, [plan]);

  return (
    <div>
      {config.steps.map((step, i) => (
        <div key={i} style={stepCardStyle} data-testid={`transform-step-${step.kind}`}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ink3)', textTransform: 'uppercase', letterSpacing: '.03em' }}>
              {STEP_LABEL[step.kind]}
            </span>
            <button type="button" aria-label="Remove step" onClick={() => removeStep(i)} style={removeBtnStyle}>
              {'\u2715'}
            </button>
          </div>
          {step.kind === 'filter' && <FilterStepEditor step={step} fields={fields} onChange={(next) => updateStep(i, next)} />}
          {step.kind === 'computed_field' && <ComputedFieldStepEditor step={step} onChange={(next) => updateStep(i, next)} />}
          {step.kind === 'drop_fields' && <DropFieldsStepEditor step={step} fields={fields} onChange={(next) => updateStep(i, next)} />}
          {step.kind === 'aggregate' && <AggregateStepEditor step={step} fields={fields} onChange={(next) => updateStep(i, next)} />}
        </div>
      ))}

      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        <button type="button" onClick={() => addStep('filter')} style={addStepBtnStyle}>
          + Filter
        </button>
        <button type="button" onClick={() => addStep('computed_field')} style={addStepBtnStyle}>
          + Computed field
        </button>
        <button type="button" onClick={() => addStep('drop_fields')} style={addStepBtnStyle}>
          + Drop fields
        </button>
        <button type="button" onClick={() => addStep('aggregate')} style={addStepBtnStyle}>
          + Aggregate
        </button>
      </div>

      {config.steps.length > 0 && (
        <div style={{ borderTop: '1px solid var(--line2)', paddingTop: 12 }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ink4)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
            Pushdown
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--ink)', marginBottom: 8 }}>
            Pushed down: {plan.pushedDownCount} · In-stream: {plan.residualCount}
          </div>
          {fragmentText && (
            <div style={{ position: 'relative' }}>
              <pre
                style={{
                  fontFamily: 'var(--font-data)',
                  fontSize: 11.5,
                  color: 'var(--ink)',
                  background: 'var(--surface)',
                  border: '1px solid var(--line2)',
                  borderRadius: 6,
                  padding: '8px 10px',
                  overflowX: 'auto',
                  whiteSpace: 'pre-wrap',
                  margin: 0,
                }}
              >
                {fragmentText}
              </pre>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(fragmentText);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                }}
                style={{
                  position: 'absolute',
                  top: 6,
                  right: 6,
                  fontSize: 11,
                  border: '1px solid var(--line2)',
                  background: 'var(--surface2)',
                  borderRadius: 6,
                  padding: '2px 8px',
                  cursor: 'pointer',
                  color: 'var(--ink3)',
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          )}
          {!fragmentText && <div style={{ fontSize: 11.5, color: 'var(--ink4)' }}>Nothing pushes down for this connection yet.</div>}
        </div>
      )}
    </div>
  );
}

const addStepBtnStyle = {
  fontSize: 12,
  border: '1px dashed var(--line2)',
  background: 'none',
  borderRadius: 6,
  padding: '5px 9px',
  cursor: 'pointer',
  color: 'var(--ink3)',
} as const;
