import { useState } from 'react';
import { parseExpression, stringifyExpression, type TransformStep } from '@nia/schemas';
import { inputStyle, OnFailureSelect, rowStyle } from './shared';

export function ComputedFieldStepEditor({
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
        <span style={{ fontSize: 12, color: 'var(--nx-ink-disabled)', width: 40 }}>Name</span>
        <input
          data-testid="computed-field-name"
          value={step.name}
          onChange={(e) => onChange({ ...step, name: e.target.value })}
          style={{ ...inputStyle, flex: 1 }}
        />
      </div>
      <div style={rowStyle}>
        <span style={{ fontSize: 12, color: 'var(--nx-ink-disabled)', width: 40 }}>Expr</span>
        <input
          data-testid="computed-field-expr"
          value={raw}
          onChange={(e) => handleExpressionChange(e.target.value)}
          placeholder='concat(first_name, " ", last_name)'
          style={{ ...inputStyle, flex: 1, fontFamily: 'var(--nx-font-mono)', borderColor: error ? 'var(--nx-danger)' : 'var(--nx-line)' }}
        />
      </div>
      {error && <div style={{ fontSize: 11.5, color: 'var(--nx-danger)', marginTop: 2 }}>{error}</div>}
      <div style={{ fontSize: 10.5, color: 'var(--nx-ink-disabled)', marginTop: 4, marginBottom: 8 }}>
        Fields, numbers/strings, <span style={{ fontFamily: 'var(--nx-font-mono)' }}>+ - * /</span>, concat(), coalesce().
      </div>
      <OnFailureSelect value={step.onFailure} onChange={(v) => onChange({ ...step, onFailure: v })} />
    </div>
  );
}
