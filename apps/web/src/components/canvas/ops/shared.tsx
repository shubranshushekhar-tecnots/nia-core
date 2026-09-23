import type { FilterOperator, OnFailurePolicy } from '@nia/schemas';

/**
 * Shared styling/helpers consumed by more than one op editor
 * (FilterStepEditor, AggregateStepEditor, ...). Extracted verbatim from
 * TransformEditor.tsx during Phase 8a's registry migration — no behavior
 * change, just relocation so each op's editor can live in its own module.
 */

export const OPERATORS: { value: FilterOperator; label: string }[] = [
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

export function coerceValue(raw: string): string | number {
  if (raw.trim() !== '' && !Number.isNaN(Number(raw)) && String(Number(raw)) === raw.trim()) return Number(raw);
  return raw;
}

export const rowStyle = { display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' } as const;
export const inputStyle = {
  height: 28,
  borderRadius: 6,
  border: '1px solid var(--line2)',
  padding: '0 8px',
  fontSize: 12.5,
  boxSizing: 'border-box',
  color: 'var(--ink)',
  background: 'var(--surface)',
} as const;
export const removeBtnStyle = { border: 'none', background: 'none', color: 'var(--bad)', cursor: 'pointer', fontSize: 12, padding: 0 } as const;
export const addStepBtnStyle = {
  fontSize: 12,
  border: '1px dashed var(--line2)',
  background: 'none',
  borderRadius: 6,
  padding: '5px 9px',
  cursor: 'pointer',
  color: 'var(--ink3)',
} as const;

export function FieldSelect({
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

/**
 * Phase 8b-3 — onFailure policy select, shared by every op editor whose step
 * can carry a fallible call (filter/computed_field/aggregate). Mirrors
 * nodeConfig.ts's OnFailurePolicy doc comment: absent means "fail", which
 * this renders as an explicit "fail" option (not a blank/placeholder) so the
 * default is visible, not hidden. "quarantine" is listed too (schema-valid)
 * even though it's rejected at compile time until Phase 11's sink exists —
 * checkConfig surfaces that rejection same as any other config error.
 */
const ON_FAILURE_OPTIONS: { value: OnFailurePolicy; label: string }[] = [
  { value: 'fail', label: 'Fail the run' },
  { value: 'null', label: 'Set to null' },
  { value: 'drop', label: 'Drop the row' },
  { value: 'quarantine', label: 'Quarantine (Phase 11)' },
];

export function OnFailureSelect({
  value,
  onChange,
}: {
  value: OnFailurePolicy | undefined;
  onChange: (v: OnFailurePolicy) => void;
}) {
  return (
    <div style={rowStyle}>
      <span style={{ fontSize: 12, color: 'var(--ink4)', width: 90 }}>On failure</span>
      <select
        value={value ?? 'fail'}
        onChange={(e) => onChange(e.target.value as OnFailurePolicy)}
        style={{ ...inputStyle, flex: 1 }}
      >
        {ON_FAILURE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
