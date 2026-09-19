import type { TransformStep } from '@nia/schemas';

export function DropFieldsStepEditor({
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
