'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  compilePushdown,
  manifestDialect,
  OP_REGISTRY,
  type TransformConfig,
  type TransformStep,
} from '@nia/schemas';
import { getConnectionSchema } from '@/lib/api/connectionsClient';
import { OP_EDITOR_REGISTRY } from './ops/registry';
import { addStepBtnStyle, removeBtnStyle } from './ops/shared';

/**
 * Task 2's declarative transform editor (filter / computed field / drop
 * fields) + Task 3's pushdown transparency panel, colocated since both
 * operate on the same TransformConfig + resolved dialect. Field
 * suggestions come from the immediate upstream source's introspected
 * schema (apps/api's GET /connections/:id/schema, cached client-side by
 * TanStack Query) — a union across all of that connection's entities/
 * tables, since source nodes don't have per-entity selection yet (Session
 * 2 scope cut, see nodeConfig.ts).
 *
 * Phase 8a: per-kind editor components moved to ./ops/ (one module per
 * op, registered in OP_EDITOR_REGISTRY) — this file just renders whatever
 * OP_EDITOR_REGISTRY[step.kind] resolves to, and sources new-step default
 * shapes from @nia/schemas' OP_REGISTRY[kind].createDefault() instead of
 * a local kind ternary.
 */

const stepCardStyle = {
  border: '1px solid var(--line2)',
  borderRadius: 8,
  padding: 10,
  marginBottom: 10,
  background: 'var(--surface2)',
} as const;

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
    const step = OP_REGISTRY[kind].createDefault();
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
      {config.steps.map((step, i) => {
        const entry = OP_EDITOR_REGISTRY[step.kind];
        const Editor = entry.Component;
        return (
          <div key={i} style={stepCardStyle} data-testid={`transform-step-${step.kind}`}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ink3)', textTransform: 'uppercase', letterSpacing: '.03em' }}>
                {entry.label}
              </span>
              <button type="button" aria-label="Remove step" onClick={() => removeStep(i)} style={removeBtnStyle}>
                {'\u2715'}
              </button>
            </div>
            <Editor step={step as never} fields={fields} onChange={(next) => updateStep(i, next as TransformStep)} />
          </div>
        );
      })}

      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {(Object.keys(OP_EDITOR_REGISTRY) as TransformStep['kind'][]).map((kind) => (
          <button key={kind} type="button" onClick={() => addStep(kind)} style={addStepBtnStyle}>
            + {OP_EDITOR_REGISTRY[kind].label}
          </button>
        ))}
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
