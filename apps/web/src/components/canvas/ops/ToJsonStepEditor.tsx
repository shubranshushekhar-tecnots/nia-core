import type { TransformStep } from '@nia/schemas';
import { FieldSelect, inputStyle, rowStyle } from './shared';

/** to_json(field) -> outputName — see nodeConfig.ts's ToJsonStep doc comment. Never fallible (any JS value is valid JSON), so no OnFailureSelect here, unlike filter/computed_field/aggregate. */
export function ToJsonStepEditor({
  step,
  fields,
  onChange,
}: {
  step: Extract<TransformStep, { kind: 'to_json' }>;
  fields: string[];
  onChange: (next: Extract<TransformStep, { kind: 'to_json' }>) => void;
}) {
  return (
    <div>
      <div style={rowStyle}>
        <span style={{ fontSize: 12, color: 'var(--ink4)', width: 70 }}>Field</span>
        <FieldSelect value={step.field} onChange={(v) => onChange({ ...step, field: v })} fields={fields} />
      </div>
      <div style={rowStyle}>
        <span style={{ fontSize: 12, color: 'var(--ink4)', width: 70 }}>Output name</span>
        <input
          value={step.outputName}
          onChange={(e) => onChange({ ...step, outputName: e.target.value })}
          placeholder="output column name"
          style={{ ...inputStyle, flex: 1, fontFamily: 'var(--font-data)' }}
        />
      </div>
    </div>
  );
}
