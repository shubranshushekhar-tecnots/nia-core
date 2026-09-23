'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  buildDestinationContract,
  fieldNamesForEntity,
  manifestDialect,
  schemaFromIntrospection,
  type CheckResult,
  type DestinationContract,
  type FieldMapping,
  type MappingEntry,
  type PreviewValue,
  type SourceDestConfig,
} from '@nia/schemas';
import type { EntityRef, IntrospectResponse } from '@nia/schemas';
import { defaultDestinationField } from '@/lib/canvas/mappingDefaults';
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
const unmappedCardStyle = {
  border: '1px solid var(--warn-bd)',
  background: 'var(--warn-bg)',
  borderRadius: 10,
  padding: 10,
  marginBottom: 12,
} as const;
const unmappedFilterInputStyle = {
  ...inputStyle,
  width: '100%',
  marginBottom: 8,
} as const;
const unmappedTagListStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  maxHeight: 96,
  overflowY: 'auto',
} as const;
const unmappedTagStyle = {
  fontFamily: 'var(--font-data)',
  fontSize: 11,
  color: 'var(--warn)',
  background: 'var(--surface)',
  border: '1px solid var(--warn-bd)',
  borderRadius: 999,
  padding: '2px 8px',
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

/**
 * Item 2 fix: scoped to `entity` (a node's persisted table/collection
 * selection) via `fieldNamesForEntity` when given, instead of always
 * flattening every entity in the connection's schema into one union — the
 * same asymmetry fix applied to `proposeMapping.ts`'s destination side.
 * `entity` undefined (no persisted selection yet, e.g. a legacy node or a
 * brand-new "+ Create new…" table) falls back to `fieldNamesForEntity`'s
 * own flat-union behavior, unchanged from before this fix.
 */
function useEntityFields(connectionId?: string, entity?: EntityRef): string[] {
  const schema = useEntitySchema(connectionId);
  return useMemo(() => {
    if (!schema) return [];
    return fieldNamesForEntity(schema, entity).slice().sort();
  }, [schema, entity]);
}

/** Shares the `['connection-schema', connectionId]` query (and its react-query cache entry) with useEntityFields above — this just returns the raw IntrospectResponse instead of a flattened field-name union, since the contract preview below needs one specific entity's typed fields, not a cross-entity name union. */
function useEntitySchema(connectionId?: string): IntrospectResponse | undefined {
  const { data: schema } = useQuery({
    queryKey: ['connection-schema', connectionId],
    queryFn: () => getConnectionSchema(connectionId!),
    enabled: !!connectionId,
    staleTime: 5 * 60_000,
  });
  return schema;
}

const emptyMapping: FieldMapping = { version: 1, entries: [], approvedAt: null };

export default function MappingEditor({
  config,
  workflowId,
  destNodeId,
  destConnectionId,
  destManifestId,
  sourceConnectionId,
  sourceManifestId,
  sourceEntity,
  sourceFieldsOverride,
  checkResults,
  onChange,
}: {
  config: SourceDestConfig;
  workflowId: string;
  destNodeId: string;
  destConnectionId?: string;
  /** Schema layer Part 4 — the destination node's own manifestId (NodeDrawer.tsx's `data.manifestId`), needed to resolve a dialect for the contract preview below. */
  destManifestId?: string;
  sourceConnectionId?: string;
  /** Schema layer Part 4 — mirrors destManifestId above, sourced from upstream.ts's findUpstreamSource. */
  sourceManifestId?: string;
  /** Schema layer Part 4 — the upstream source node's persisted entity ref (upstream.ts's findUpstreamSource), needed to look up its typed field list for the contract preview. Undefined when no entity is selected yet, same as the source node's own picker state. */
  sourceEntity?: EntityRef;
  /**
   * When a single Aggregate transform sits between the source and this
   * destination, NodeDrawer.tsx computes the transform's actual output
   * field names (pushdown.ts's transformOutputFields — groupBy columns +
   * aggregation aliases) and passes them here, overriding the raw
   * introspected source columns below: those raw columns don't exist in
   * the query result once GROUP BY has run, so offering them in the "from"
   * dropdown would let the user pick a field the run can never produce.
   * Undefined (not just empty) means "no override" — falls back to
   * useEntityFields(sourceConnectionId) unchanged, same as before this
   * prop existed.
   */
  sourceFieldsOverride?: string[];
  /** Latest persisted check-run results (FlowCanvas's latestCheckRun.results), or null if none has run yet. Reused as-is to gate Preview — no new validation logic, see runPreview.ts's header comment. */
  checkResults?: CheckResult[] | null;
  onChange: (next: SourceDestConfig) => void;
}) {
  const mapping = config.mapping ?? emptyMapping;
  const rawSourceFields = useEntityFields(sourceConnectionId, sourceEntity);
  const sourceFields = sourceFieldsOverride ?? rawSourceFields;
  const destFields = useEntityFields(destConnectionId, config.entity);

  const [proposing, setProposing] = useState(false);
  const [proposeError, setProposeError] = useState<string | undefined>(undefined);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<PreviewValue | undefined>(undefined);
  const [unmappedFilter, setUnmappedFilter] = useState('');

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
    const from = sourceFields[0] ?? '';
    updateEntries([...mapping.entries, { from, to: defaultDestinationField(from, destFields, mapping.entries) }]);
  }

  /** Schema layer, Part 5 — snapshots the source's current live field list alongside the approval, so every run can later diff against it to detect new source columns (nodeConfig.ts's FieldMapping.sourceColumnsAtApproval doc comment). */
  function approve() {
    onChange({
      ...config,
      mapping: {
        version: mapping.version + 1,
        entries: mapping.entries,
        approvedAt: new Date().toISOString(),
        sourceColumnsAtApproval: sourceFields,
      },
    });
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
  const mappedDestFieldsList = Array.from(mappedDestFields).filter((f) => f !== '').sort();
  const upsertKeys = config.upsertKeys ?? [];

  /**
   * Schema layer Part 4 — "the preview shows source path -> destination
   * name -> type, a fidelity badge, ... Degraded fields are highlighted."
   * Computed client-side with the same pure functions ensureDestination.ts
   * (apps/worker) uses server-side at run time — no new API endpoint,
   * since both the source and destination schemas are already fetched
   * here for the field dropdowns above.
   *
   * Disclosed scope narrowing: only built for a declared-schema source
   * (schemaFromIntrospection) with no aggregate transform upstream
   * (sourceFieldsOverride unset) — an inferred (Mongo/file) or
   * post-aggregate source's real NiaTypes require the profiler sample /
   * transformOutputFields' compiled output schema, neither of which this
   * panel has on hand. ensureDestination.ts itself has no such limit (it
   * always has the full resolved entity at run time); this is a preview-
   * only gap, not a run-time one.
   */
  const sourceSchemaResponse = useEntitySchema(sourceConnectionId);
  const sourceDialect = manifestDialect(sourceManifestId);
  const destDialect = manifestDialect(destManifestId);
  const sourceEntityDef =
    sourceEntity && sourceSchemaResponse
      ? sourceSchemaResponse.entities.find((e) => e.namespace === sourceEntity.namespace && e.name === sourceEntity.name)
      : undefined;
  const contract = useMemo<DestinationContract | undefined>(() => {
    if (sourceFieldsOverride || !sourceEntityDef || !sourceDialect || !destDialect || !config.entity) return undefined;
    if (mapping.entries.length === 0 || upsertKeys.length === 0) return undefined;
    if (mapping.entries.some((e) => e.from === '' || e.to === '')) return undefined;
    try {
      const { schema: sourceSchema } = schemaFromIntrospection(sourceEntityDef, sourceDialect);
      const keySourcePaths = mapping.entries.filter((e) => upsertKeys.includes(e.to)).map((e) => e.from);
      return buildDestinationContract({
        dialect: destDialect,
        entity: config.entity,
        sourceSchema,
        mapping: mapping.entries.map((e) => ({ from: e.from, to: e.to })),
        keySourcePaths,
      });
    } catch {
      return undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceFieldsOverride, sourceEntityDef, sourceDialect, destDialect, config.entity, mapping.entries, upsertKeys]);

  /** Destination-only, see nodeConfig.ts's SourceDestConfig comment — the runner (runEtl.ts) upserts on these dest field names, required for this node to actually run. */
  function toggleUpsertKey(field: string) {
    const next = upsertKeys.includes(field) ? upsertKeys.filter((f) => f !== field) : [...upsertKeys, field];
    onChange({ ...config, upsertKeys: next });
  }
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
        <div style={unmappedCardStyle}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--warn)', marginBottom: 8 }}>
            Unmapped destination fields ({unmappedDestFields.length})
          </div>
          {unmappedDestFields.length > 8 && (
            <input
              value={unmappedFilter}
              onChange={(e) => setUnmappedFilter(e.target.value)}
              placeholder="Filter fields…"
              style={unmappedFilterInputStyle}
            />
          )}
          <div style={unmappedTagListStyle}>
            {unmappedDestFields
              .filter((f) => f.toLowerCase().includes(unmappedFilter.toLowerCase()))
              .map((f) => (
                <span key={f} style={unmappedTagStyle}>
                  {f}
                </span>
              ))}
          </div>
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
        <div style={sectionHeaderStyle}>Upsert keys</div>
        <div style={{ fontSize: 11.5, color: 'var(--ink4)', marginBottom: 8 }}>
          Destination fields a run matches existing rows on. Required to run this destination.
        </div>
        {mappedDestFieldsList.length === 0 ? (
          <div style={{ fontSize: 11.5, color: 'var(--ink4)', marginBottom: 12 }}>Map at least one field first.</div>
        ) : (
          <div style={{ marginBottom: 12 }}>
            {mappedDestFieldsList.map((field) => (
              <label
                key={field}
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--ink)', marginBottom: 4, cursor: 'pointer' }}
              >
                <input type="checkbox" checked={upsertKeys.includes(field)} onChange={() => toggleUpsertKey(field)} />
                <span style={{ fontFamily: 'var(--font-data)' }}>{field}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div style={{ borderTop: '1px solid var(--line2)', marginTop: 16, paddingTop: 16 }}>
        <div style={sectionHeaderStyle}>Destination contract</div>
        {sourceFieldsOverride ? (
          <div style={{ fontSize: 11.5, color: 'var(--ink4)', marginBottom: 4 }}>
            Preview unavailable with an Aggregate transform upstream.
          </div>
        ) : contract ? (
          <ContractPreview contract={contract} />
        ) : (
          <div style={{ fontSize: 11.5, color: 'var(--ink4)', marginBottom: 4 }}>
            Map at least one field, pick a destination table, and select an upsert key to preview the contract.
          </div>
        )}
      </div>

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

const contractTableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 11.5 } as const;
const contractThStyle = {
  textAlign: 'left',
  fontWeight: 600,
  color: 'var(--ink4)',
  textTransform: 'uppercase',
  letterSpacing: '.03em',
  fontSize: 10,
  padding: '0 8px 6px 0',
  borderBottom: '1px solid var(--line2)',
} as const;
const contractTdStyle = { padding: '5px 8px 5px 0', borderBottom: '1px solid var(--line2)', verticalAlign: 'top' } as const;

/**
 * Schema layer Part 4's UI bullet: "The preview shows source path ->
 * destination name -> type, a fidelity badge, and a JSON/flatten toggle
 * per nested field. Degraded fields are highlighted."
 *
 * Disclosed scope narrowings:
 *  - "Degraded" here means `fidelity.kind === 'lossy'` (niaAdapters.ts) —
 *    the only per-column fidelity signal this contract actually carries.
 *    NiaType's own `degraded` flag (niaType.ts) is a join()-time concept
 *    from multi-sample inference; a contract built from
 *    schemaFromIntrospection's single declared type per field never
 *    produces one, so there's nothing else to highlight against.
 *  - The "JSON/flatten toggle" is rendered as a static badge, not an
 *    interactive control: destinationContract.ts's own doc comment on
 *    `nestedFieldStrategy` says plainly there's "no behavior behind
 *    'flatten' yet" (real flattening only happens via an upstream
 *    `flatten` TransformStep, Part 3) — a working toggle here would imply
 *    a write-path effect that doesn't exist.
 */
function ContractPreview({ contract }: { contract: DestinationContract }) {
  return (
    <table style={contractTableStyle}>
      <thead>
        <tr>
          <th style={contractThStyle}>Source</th>
          <th style={contractThStyle}>Destination</th>
          <th style={contractThStyle}>Type</th>
          <th style={contractThStyle}>Fidelity</th>
          <th style={contractThStyle}>Key</th>
        </tr>
      </thead>
      <tbody>
        {contract.columns.map((col) => {
          const lossy = col.fidelity.kind === 'lossy';
          const isNested = col.niaType.kind === 'object' || col.niaType.kind === 'array';
          return (
            <tr key={col.destinationName}>
              <td style={{ ...contractTdStyle, fontFamily: 'var(--font-data)', color: 'var(--ink3)' }}>{col.sourcePath}</td>
              <td style={{ ...contractTdStyle, fontFamily: 'var(--font-data)' }}>
                {col.destinationName}
                {isNested && (
                  <span
                    style={{
                      marginLeft: 6,
                      fontSize: 9.5,
                      fontWeight: 600,
                      color: 'var(--ink4)',
                      border: '1px solid var(--line2)',
                      borderRadius: 999,
                      padding: '1px 6px',
                    }}
                  >
                    {col.nestedFieldStrategy}
                  </span>
                )}
              </td>
              <td style={contractTdStyle}>{col.niaType.kind}</td>
              <td style={contractTdStyle} title={col.fidelity.kind === 'lossy' ? col.fidelity.reason : undefined}>
                {lossy ? (
                  <span style={{ fontWeight: 600, color: 'var(--warn)' }}>lossy</span>
                ) : (
                  <span style={{ color: 'var(--ink4)' }}>lossless</span>
                )}
              </td>
              <td style={contractTdStyle}>{col.isKey ? '\u2713' : ''}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
