'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  compilePushdown,
  manifestDialect,
  OP_REGISTRY,
  updateStepProvenance,
  type TransformConfig,
  type TransformStep,
} from '@nia/schemas';
import { getConnectionSchema } from '@/lib/api/connectionsClient';
import { CleanApiError, proposeCleaning } from '@/lib/api/cleanClient';
import { useCanvasStore } from '@/lib/canvas/store';
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
  workflowId,
  nodeId,
  onChange,
}: {
  config: TransformConfig;
  connectionId?: string;
  manifestId?: string;
  /** Both required only for Step 7's "Propose cleaning" call — the node's own id (clean_plans binds to a transform node) and its workflow. */
  workflowId: string;
  nodeId: string;
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

  // Phase 13, Step 7 — "Propose cleaning". `cleanProposal` is store-global
  // (shared with FlowCanvas's ghost-diff Apply/Discard banner), so this
  // only renders its own detail panel when the stored proposal targets
  // THIS node — switching to another node's drawer just hides the panel,
  // it doesn't clear the pending proposal.
  const cleanProposal = useCanvasStore((s) => s.cleanProposal);
  const setCleanProposal = useCanvasStore((s) => s.setCleanProposal);
  const [proposing, setProposing] = useState(false);
  const [proposeError, setProposeError] = useState<string | null>(null);
  const activeProposal = cleanProposal?.nodeId === nodeId ? cleanProposal : null;

  async function handleProposeCleaning() {
    setProposing(true);
    setProposeError(null);
    try {
      const result = await proposeCleaning(workflowId, nodeId);
      setCleanProposal({ ...result, nodeId });
    } catch (err) {
      setProposeError(err instanceof CleanApiError ? err.message : 'Propose cleaning failed — try again.');
    } finally {
      setProposing(false);
    }
  }

  // Phase 12 — any edit made through this UI is, by definition, manual: it
  // resets/overwrites whatever provenance a step carried (e.g. `copilot`+
  // planId from a plan apply), so a later revert-conflict check correctly
  // sees "this step was changed since the plan was applied" (see
  // StepProvenance's doc comment).
  function updateStep(i: number, next: TransformStep) {
    const steps = config.steps.slice();
    steps[i] = updateStepProvenance(next, { source: 'manual' });
    onChange({ ...config, steps });
  }
  function removeStep(i: number) {
    onChange({ ...config, steps: config.steps.filter((_, idx) => idx !== i) });
  }
  function addStep(kind: TransformStep['kind']) {
    const step = updateStepProvenance(OP_REGISTRY[kind].createDefault(), { source: 'manual' });
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

      <div style={{ borderTop: '1px solid var(--line2)', paddingTop: 12, marginTop: 16 }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ink4)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
          Clean proposal
        </div>
        <button type="button" onClick={handleProposeCleaning} disabled={proposing} style={addStepBtnStyle}>
          {proposing ? 'Proposing\u2026' : 'Propose cleaning'}
        </button>
        {proposeError && <div style={{ fontSize: 11.5, color: 'var(--bad)', marginTop: 6 }}>{proposeError}</div>}

        {activeProposal && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12.5, color: 'var(--ink)', marginBottom: 8 }}>{activeProposal.diff.summary}</div>

            {activeProposal.columns.map((col) => (
              <div key={col.column} style={stepCardStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontWeight: 600, fontSize: 12.5 }}>{col.column}</span>
                  <span style={{ fontSize: 11, color: 'var(--ink4)' }}>
                    {col.specialist} · {col.included ? 'included' : 'dropped'}
                  </span>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--ink3)', marginTop: 4 }}>{col.routeReason}</div>
                <div style={{ fontSize: 12, color: 'var(--ink)', marginTop: 2 }}>{col.rationale}</div>
                <div style={{ fontSize: 11, color: 'var(--ink4)', marginTop: 4 }}>
                  onFailure: {col.onFailure} · sample {col.sampleSize} · failures {col.failureCount} (
                  {(col.failureRate * 100).toFixed(1)}% / max {(col.maxFailureRate * 100).toFixed(1)}%)
                </div>
                {!col.included && col.dropReason && (
                  <div style={{ fontSize: 11, color: 'var(--warn)', marginTop: 4 }}>Dropped: {col.dropReason}</div>
                )}
                {col.included && col.before.length > 0 && (
                  <div style={{ fontFamily: 'var(--font-data)', fontSize: 11, color: 'var(--ink3)', marginTop: 4, overflowX: 'auto' }}>
                    {col.before
                      .slice(0, 3)
                      .map((b, idx) => `${JSON.stringify(b)} \u2192 ${JSON.stringify(col.after[idx])}`)
                      .join('  \u00b7  ')}
                  </div>
                )}
              </div>
            ))}

            {activeProposal.skipped.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink4)', marginBottom: 4 }}>Skipped</div>
                {activeProposal.skipped.map((s, i) => (
                  <div key={i} style={{ fontSize: 11.5, color: 'var(--ink3)' }}>
                    {s.column} ({s.specialist}): {s.reason}
                  </div>
                ))}
              </div>
            )}

            {activeProposal.skippedIdentifierLike.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink4)', marginBottom: 4 }}>Skipped (identifier-like)</div>
                {activeProposal.skippedIdentifierLike.map((s, i) => (
                  <div key={i} style={{ fontSize: 11.5, color: 'var(--ink3)' }}>
                    {s.column}: {s.reason}
                  </div>
                ))}
              </div>
            )}

            <div style={{ fontSize: 11, color: 'var(--ink4)', marginTop: 8 }}>
              Review the diff banner above the canvas to apply or discard.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
