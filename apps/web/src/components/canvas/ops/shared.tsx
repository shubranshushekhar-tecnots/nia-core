import type { FilterOperator } from '@nia/schemas';

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
