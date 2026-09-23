import type { TransformStep } from '@nia/schemas';
import { FieldSelect, inputStyle, rowStyle } from './shared';

/** flatten(field, maxDepth) — see nodeConfig.ts's FlattenStep doc comment. Never fallible/onFailure (see there), so no OnFailureSelect here, unlike filter/computed_field/aggregate. */
export function FlattenStepEditor({
  step,
  fields,
  onChange,
}: {
  step: Extract<TransformStep, { kind: 'flatten' }>;
  fields: string[];
  onChange: (next: Extract<TransformStep, { kind: 'flatten' }>) => void;
}) {
  return (
    <div>
      <div style={rowStyle}>
        <span style={{ fontSize: 12, color: 'var(--ink4)', width: 70 }}>Field</span>
        <FieldSelect value={step.field} onChange={(v) => onChange({ ...step, field: v })} fields={fields} placeholder="object-typed field" />
      </div>
      <div style={rowStyle}>
        <span style={{ fontSize: 12, color: 'var(--ink4)', width: 70 }}>Max depth</span>
        <input
          type="number"
          min={1}
          value={step.maxDepth}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isInteger(n) && n > 0) onChange({ ...step, maxDepth: n });
          }}
          style={{ ...inputStyle, width: 80 }}
        />
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--ink4)', marginTop: 4 }}>
        Expands the field&apos;s own fields into new <span style={{ fontFamily: 'var(--font-data)' }}>field_subfield</span> columns, replacing the original.
      </div>
    </div>
  );
}
