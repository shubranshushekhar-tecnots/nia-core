'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CheckResult, FieldMapping, MappingEntry, PreviewValue, SourceDestConfig } from '@nia/schemas';
import { getConnectionSchema } from '@/lib/api/connectionsClient';
import { proposeMapping, MappingsApiError } from '@/lib/api/mappingsClient';
import { previewDestination, PreviewApiError } from '@/lib/api/previewClient';
import PreviewTable from './PreviewTable';

/**
 * Task 3, item 3 — destination-node field mapping editor. No mapping UI
 * exists in designs/Nia Core App.html (it predates this feature); this
 * borrows TransformEditor.tsx's existing form idioms (FieldSelect-style
 * dropdowns, stepCard-like rows, union-of-entities field lists) instead of
 * inventing new visual language, so this is deliberately NOT a pixel-port
 * of anything — noted here since the plan asked for that ambiguity to be
 * logged rather than silently resolved.
 *
 * "Unmapped required fields" is interpreted as "destination fields with no
 * entry in `entries`" — IntrospectResponse (contract.ts) carries no
 * required/nullable flag anywhere in this codebase, so there is no stronger
 * notion of "required" to highlight against.
 *
 * Approval is NOT a separate network call — onChange here feeds straight
 * into NodeDrawer's existing onConfigChange -> FlowCanvas's scheduleSave
 * autosave path, the same graph-save write every other node editor already
 * uses (see apps/api/src/services/mappings.ts's header comment).
 */

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
const removeBtnStyle = { border: 'none', background: 'none', color: 'var(--bad)', cursor: 'pointer', fontSize: 12, padding: 0 } as const;
const sectionHeaderStyle = {
  fontSize: 11.5,
  fontWeight: 600,
  color: 'var(--ink4)',
  textTransform: 'uppercase',
  letterSpacing: '.04em',
  marginBottom: 8,
} as const;

function FieldSelect({
  value,
  onChange,
  fields,
  placeholder,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  fields: string[];
  placeholder?: string;
  /** Phase 5 Session 5, Block 2 — schema drift: entry references a field the live schema no longer has (see driftedField() below). Red-border-only, no new copy inline; the row-level message below the entry explains why. */
  invalid?: boolean;
}) {
  const style = invalid ? { ...inputStyle, flex: 1, borderColor: 'var(--bad)' } : { ...inputStyle, flex: 1 };
  if (fields.length === 0) {
    return (
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? 'field name'}
        style={{ ...style, fontFamily: 'var(--font-data)' }}
      />
    );
  }
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={style}>
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
 * Phase 5 Session 5, Block 2 — schema drift detection. CheckResult carries
 * no structured field reference (message string only — see checks.ts), so
 * rather than parsing that string this compares the entry's own value
 * against the live-fetched field list (already on hand via useEntityFields,
 * same data the FieldSelect dropdowns render from). Only flags once the
 * live list has actually loaded (`fields.length > 0`) so an entry never
 * flashes "drifted" while the schema query is still in flight — same
 * loading-guard reasoning as the schema-race bug noted in session notes.
 */
function driftedField(value: string, fields: string[]): boolean {
  return value !== '' && fields.length > 0 && !fields.includes(value);
}

function useEntityFields(connectionId?: string): string[] {
  const { data: schema } = useQuery({
    queryKey: ['connection-schema', connectionId],
    queryFn: () => getConnectionSchema(connectionId!),
    enabled: !!connectionId,
    staleTime: 5 * 60_000,
  });
  return useMemo(() => {
    if (!schema) return [];
    const set = new Set<string>();
    for (const entity of schema.entities) for (const f of entity.fields) set.add(f.name);
    return Array.from(set).sort();
  }, [schema]);
}

const emptyMapping: FieldMapping = { version: 1, entries: [], approvedAt: null };

export default function MappingEditor({
  config,
  workflowId,
  destNodeId,
  destConnectionId,
  sourceConnectionId,
  checkResults,
  onChange,
}: {
  config: SourceDestConfig;
  workflowId: string;
  destNodeId: string;
  destConnectionId?: string;
  sourceConnectionId?: string;
  /** Latest persisted check-run results (FlowCanvas's latestCheckRun.results), or null if none has run yet. Reused as-is to gate Preview — no new validation logic, see runPreview.ts's header comment. */
  checkResults?: CheckResult[] | null;
  onChange: (next: SourceDestConfig) => void;
}) {
  const mapping = config.mapping ?? emptyMapping;
  const sourceFields = useEntityFields(sourceConnectionId);
  const destFields = useEntityFields(destConnectionId);

  const [proposing, setProposing] = useState(false);
  const [proposeError, setProposeError] = useState<string | undefined>(undefined);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<PreviewValue | undefined>(undefined);

  /** Any edit to entries clears approvedAt — drift honesty, per FieldMapping's header comment in nodeConfig.ts. */
  function updateEntries(entries: MappingEntry[]) {
    onChange({ ...config, mapping: { ...mapping, entries, approvedAt: null } });
  }

  function updateEntry(i: number, patch: Partial<MappingEntry>) {
    const next = mapping.entries.slice();
    next[i] = { ...next[i]!, ...patch };
    updateEntries(next);
  }

  function removeEntry(i: number) {
    updateEntries(mapping.entries.filter((_, idx) => idx !== i));
  }

  function addEntry() {
    updateEntries([...mapping.entries, { from: sourceFields[0] ?? '', to: destFields[0] ?? '' }]);
  }

  function approve() {
    onChange({ ...config, mapping: { version: mapping.version + 1, entries: mapping.entries, approvedAt: new Date().toISOString() } });
  }

  async function handlePropose() {
    setProposing(true);
    setProposeError(undefined);
    try {
      const proposal = await proposeMapping(workflowId, destNodeId);
      updateEntries(proposal.entries);
    } catch (err) {
      setProposeError(err instanceof MappingsApiError ? err.message : 'Failed to propose a mapping.');
    } finally {
      setProposing(false);
    }
  }

  async function handlePreview() {
    setPreviewing(true);
    setPreviewError(undefined);
    try {
      setPreview(await previewDestination(workflowId, destNodeId));
    } catch (err) {
      setPreviewError(err instanceof PreviewApiError ? err.message : 'Failed to run preview.');
    } finally {
      setPreviewing(false);
    }
  }

  const mappedDestFields = new Set(mapping.entries.map((e) => e.to));
  const unmappedDestFields = destFields.filter((f) => !mappedDestFields.has(f));
  const isApproved = !!mapping.approvedAt;
  // Preview requires an approved mapping + a passing config check for this
  // path — reuses the same persisted check-run results the ChecksDock
  // already shows, no new validation logic (runPreview.ts's worker-side
  // handler re-derives this itself too, so this is a UI-gating convenience
  // only, not the enforcement — same convention as can.ts).
  const failingCheckForThisNode = (checkResults ?? []).find((r) => r.nodeId === destNodeId && r.status === 'fail');
  const previewDisabled = previewing || !isApproved || !!failingCheckForThisNode;
  const previewDisabledReason = !isApproved
    ? 'Approve the mapping before previewing.'
    : failingCheckForThisNode
      ? failingCheckForThisNode.message
      : undefined;
  // Entries may legitimately sit at "" mid-edit (nodeConfig.ts's MappingEntry
  // comment — e.g. a freshly-added entry before a field is picked, or while
  // the other side's schema is still loading), but approving an incomplete
  // entry would pass checkMappings' approval gate while checkConfig still
  // fails it as incomplete (checks.ts) — a confusing "approved but still
  // failing" state. Block Approve until every entry has both sides set.
  const hasIncompleteEntry = mapping.entries.some((e) => e.from === '' || e.to === '');
  const approveDisabled = mapping.entries.length === 0 || isApproved || hasIncompleteEntry;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={sectionHeaderStyle}>Field mapping</div>
        {isApproved ? (
          <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--good, #16a34a)' }}>Approved</span>
        ) : (
          <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--warn)' }}>Not approved</span>
        )}
      </div>

      <button
        type="button"
        onClick={handlePropose}
        disabled={proposing || !sourceConnectionId || !destConnectionId}
        style={{
          fontSize: 12,
          fontWeight: 600,
          border: '1px solid var(--line2)',
          background: 'var(--surface2)',
          borderRadius: 6,
          padding: '5px 10px',
          cursor: proposing ? 'default' : 'pointer',
          color: 'var(--ink)',
          marginBottom: 10,
        }}
      >
        {proposing ? 'Proposing…' : 'Propose mapping'}
      </button>

      {proposeError && (
        <div style={{ fontSize: 11.5, color: 'var(--bad)', marginBottom: 10 }}>
          {proposeError}{' '}
          <button
            type="button"
            onClick={handlePropose}
            style={{ border: 'none', background: 'none', color: 'var(--bad)', textDecoration: 'underline', cursor: 'pointer', fontSize: 11.5, padding: 0 }}
          >
            Retry
          </button>
        </div>
      )}

      {mapping.entries.map((entry, i) => {
        const fromDrifted = driftedField(entry.from, sourceFields);
        const toDrifted = driftedField(entry.to, destFields);
        return (
          <div key={i}>
            <div style={rowStyle}>
              <FieldSelect value={entry.from} onChange={(v) => updateEntry(i, { from: v })} fields={sourceFields} placeholder="source field" invalid={fromDrifted} />
              <span style={{ color: 'var(--ink4)', fontSize: 12 }}>{'\u2192'}</span>
              <FieldSelect value={entry.to} onChange={(v) => updateEntry(i, { to: v })} fields={destFields} placeholder="dest field" invalid={toDrifted} />
              <button type="button" aria-label="Remove entry" onClick={() => removeEntry(i)} style={removeBtnStyle}>
                {'\u2715'}
              </button>
            </div>
            {(fromDrifted || toDrifted) && (
              <div style={{ fontSize: 11, color: 'var(--bad)', marginTop: -4, marginBottom: 8 }}>
                {fromDrifted ? `"${entry.from}" ` : `"${entry.to}" `}
                no longer exists in the {fromDrifted ? 'source' : 'destination'} schema — pick a new field.
              </div>
            )}
          </div>
        );
      })}

      <button
        type="button"
        onClick={addEntry}
        style={{ fontSize: 12, border: '1px dashed var(--line2)', background: 'none', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', color: 'var(--ink3)', marginBottom: 12 }}
      >
        + Entry
      </button>

      {unmappedDestFields.length > 0 && (
        <div style={{ fontSize: 11.5, color: 'var(--warn)', marginBottom: 12 }}>
          Unmapped destination fields: {unmappedDestFields.join(', ')}
        </div>
      )}

      <button
        type="button"
        onClick={approve}
        disabled={approveDisabled}
        style={{
          fontSize: 12.5,
          fontWeight: 600,
          color: approveDisabled ? 'var(--ink4)' : 'var(--good, #16a34a)',
          background: 'var(--surface2)',
          border: '1px solid var(--line2)',
          borderRadius: 6,
          padding: '6px 12px',
          cursor: approveDisabled ? 'not-allowed' : 'pointer',
        }}
      >
        Approve
      </button>

      <div style={{ borderTop: '1px solid var(--line2)', marginTop: 16, paddingTop: 16 }}>
        <button
          type="button"
          onClick={handlePreview}
          disabled={previewDisabled}
          title={previewDisabledReason}
          style={{
            fontSize: 12,
            fontWeight: 600,
            border: '1px solid var(--line2)',
            background: 'var(--surface2)',
            borderRadius: 6,
            padding: '5px 10px',
            cursor: previewDisabled ? 'not-allowed' : 'pointer',
            color: previewDisabled ? 'var(--ink4)' : 'var(--ink)',
            marginBottom: 10,
          }}
        >
          {previewing ? 'Previewing…' : 'Preview'}
        </button>

        {previewDisabledReason && !previewing && (
          <div style={{ fontSize: 11.5, color: 'var(--ink4)', marginBottom: 10 }}>{previewDisabledReason}</div>
        )}

        {previewError && (
          <div style={{ fontSize: 11.5, color: 'var(--bad)', marginBottom: 10 }}>
            {previewError}{' '}
            <button
              type="button"
              onClick={handlePreview}
              style={{ border: 'none', background: 'none', color: 'var(--bad)', textDecoration: 'underline', cursor: 'pointer', fontSize: 11.5, padding: 0 }}
            >
              Retry
            </button>
          </div>
        )}

        {preview && <PreviewTable preview={preview} />}
      </div>
    </div>
  );
}
