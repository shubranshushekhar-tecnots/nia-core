'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CONNECTOR_MANIFESTS, WRITE_OPERATIONS, parseNodeConfig, type CheckResult, type EntityRef, type Operation, type SourceDestConfig, type TransformConfig } from '@nia/schemas';
import type { CanvasNode } from '@/lib/canvas/mapping';
import { getConnectionSchema, getWriteGrants } from '@/lib/api/connectionsClient';
import TransformEditor from './TransformEditor';
import MappingEditor from './MappingEditor';

/**
 * Node properties drawer — docked to the canvas's right edge, replacing
 * NodeConfigPanel.tsx (dead code: it imported a `CanvasNode` shape from
 * lib/dashboard/types that no longer matches this canvas's actual node
 * data at all — never wired to any click handler, confirmed via grep
 * before writing this). Content branches on the node's resolution/type:
 *   - unresolved ("unknown tool")  -> read-only, delete-only
 *   - source / destination         -> verb selector, write verbs locked
 *   - transform                    -> TransformEditor (filter/computed/drop)
 */

const drawerStyle = {
  position: 'absolute',
  right: 16,
  top: 16,
  bottom: 16,
  width: 320,
  background: 'var(--surface)',
  border: '1px solid var(--line2)',
  borderRadius: 12,
  boxShadow: '0 4px 16px rgba(15,23,42,.10)',
  padding: 16,
  overflowY: 'auto',
  boxSizing: 'border-box',
  zIndex: 20,
} as const;

const sectionHeaderStyle = {
  fontSize: 11.5,
  fontWeight: 600,
  color: 'var(--ink4)',
  textTransform: 'uppercase',
  letterSpacing: '.04em',
  marginBottom: 8,
} as const;

const lockedBadgeStyle = {
  marginLeft: 6,
  fontSize: 10,
  fontWeight: 600,
  color: 'var(--warn)',
  background: 'var(--warn-bg)',
  border: '1px solid var(--warn-bd)',
  borderRadius: 999,
  padding: '1px 6px',
} as const;

/** `entity` refs have no natural single-string key (namespace+name can each contain anything) — NUL is never a valid identifier character in any of this codebase's supported dialects, so it's a safe join separator for a <select> option value. */
const ENTITY_KEY_SEP = '\u0000';
function entityKey(ref: EntityRef): string {
  return `${ref.namespace}${ENTITY_KEY_SEP}${ref.name}`;
}
function parseEntityKey(key: string): EntityRef {
  const [namespace, name] = key.split(ENTITY_KEY_SEP);
  return { namespace: namespace ?? '', name: name ?? '' };
}

/**
 * Phase 6 Block 0 — mirrors MappingEditor.tsx's useEntityFields, same query
 * key (`['connection-schema', connectionId]`) so both hooks share one
 * react-query cache entry per connection rather than double-fetching.
 * Returns entities (not a flat field union) since this hook backs the
 * table/entity picker, not a field dropdown. Block 2 extends this hook's
 * caller to destination nodes too — a destination now also needs an entity
 * selected so checkGrants/the lock logic below have a namespace to check
 * write-grant coverage against.
 */
function useConnectionEntities(connectionId?: string): { namespace: string; name: string }[] {
  const { data: schema } = useQuery({
    queryKey: ['connection-schema', connectionId],
    queryFn: () => getConnectionSchema(connectionId!),
    enabled: !!connectionId,
    staleTime: 5 * 60_000,
  });
  return useMemo(() => {
    if (!schema) return [];
    return schema.entities
      .map((e) => ({ namespace: e.namespace, name: e.name }))
      .sort((a, b) => (a.namespace + a.name).localeCompare(b.namespace + b.name));
  }, [schema]);
}

/**
 * Phase 6 Block 2 — the set of schema namespaces this connection has an
 * active (confirmed, unrevoked) write grant covering. Mirrors the server's
 * own check (checkGrants in @nia/schemas/checks.ts, resolveWriteGrant.ts on
 * the worker side, verifyActiveWriteGrant in connector-supabase's
 * pool-manager.ts) purely for UX — this is layer 1 of the spec's
 * three-layer guardrail (UI unlock / API validation / the write
 * credential's actual DB privileges), never the enforcement itself. A
 * grant with a scope that isn't `{ schemas: [...] }`-shaped, or with no
 * schemas array at all, covers nothing.
 */
function useGrantedNamespaces(connectionId?: string): Set<string> {
  const { data: grants } = useQuery({
    queryKey: ['connection-write-grants', connectionId],
    queryFn: () => getWriteGrants(connectionId!),
    enabled: !!connectionId,
    staleTime: 30_000,
  });
  return useMemo(() => {
    const namespaces = new Set<string>();
    for (const grant of grants ?? []) {
      if (!grant.confirmedAt || grant.revokedAt) continue;
      const schemas = (grant.scope as { schemas?: unknown } | null)?.schemas;
      if (Array.isArray(schemas)) {
        for (const s of schemas) if (typeof s === 'string') namespaces.add(s);
      }
    }
    return namespaces;
  }, [grants]);
}

function SourceDestForm({
  config,
  operations,
  nodeType,
  connectionId,
  onChange,
}: {
  config: SourceDestConfig;
  operations: Operation[];
  nodeType: 'source' | 'destination';
  connectionId?: string;
  onChange: (next: SourceDestConfig) => void;
}) {
  const entities = useConnectionEntities(connectionId);
  const grantedNamespaces = useGrantedNamespaces(connectionId);
  const selectedKey = config.entity ? entityKey(config.entity) : '';
  const namespace = config.entity?.namespace;
  const grantCovers = namespace !== undefined && grantedNamespaces.has(namespace);

  return (
    <div>
      <div style={sectionHeaderStyle}>Verb</div>
      {operations.map((op) => {
        // Phase 6 Block 2: a write verb unlocks once the node's connection
        // has a confirmed, unrevoked write grant covering the selected
        // entity's namespace — mirrors checkGrants' server-side pass
        // condition exactly (@nia/schemas/checks.ts). This is layer 1 of
        // the three-layer guardrail; the connector service and its actual
        // DB privileges (layers 2/3) still enforce this independently.
        const isWriteOp = WRITE_OPERATIONS.includes(op);
        const locked = isWriteOp && !grantCovers;
        const lockedReason = !namespace
          ? 'Select a table with an active write grant to unlock this verb.'
          : `Requires a confirmed write grant covering "${namespace}".`;
        return (
          <label
            key={op}
            title={locked ? lockedReason : undefined}
            style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: locked ? 'var(--ink4)' : 'var(--ink)', marginBottom: 6, cursor: locked ? 'not-allowed' : 'pointer' }}
          >
            <input type="radio" name="operation" disabled={locked} checked={config.operation === op} onChange={() => onChange({ ...config, operation: op })} />
            {op}
            {locked && <span style={lockedBadgeStyle}>Locked</span>}
          </label>
        );
      })}

      <div style={{ marginTop: 16 }}>
        <div style={sectionHeaderStyle}>Table</div>
        {entities.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--ink4)' }}>
            {connectionId ? 'Loading tables…' : 'Select a connection first.'}
          </div>
        ) : (
          <select
            value={selectedKey}
            onChange={(e) => onChange({ ...config, entity: e.target.value ? parseEntityKey(e.target.value) : undefined })}
            style={{ width: '100%', height: 28, borderRadius: 6, border: '1px solid var(--line2)', padding: '0 8px', fontSize: 12.5, boxSizing: 'border-box', color: 'var(--ink)', background: 'var(--surface)' }}
          >
            <option value="">{nodeType === 'source' ? 'Infer from mapping…' : 'Select a table…'}</option>
            {entities.map((e) => (
              <option key={entityKey(e)} value={entityKey(e)}>
                {e.namespace ? `${e.namespace}.${e.name}` : e.name}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

export default function NodeDrawer({
  node,
  workflowId,
  upstreamSource,
  checkResults,
  onConfigChange,
  onDelete,
  onClose,
}: {
  node: CanvasNode;
  workflowId: string;
  upstreamSource?: { connectionId?: string; manifestId?: string };
  /** Latest persisted check-run results, forwarded to MappingEditor to gate Preview. See MappingEditor.tsx's prop comment. */
  checkResults?: CheckResult[] | null;
  onConfigChange: (config: Record<string, unknown>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { data } = node;
  const manifest = data.manifestId ? CONNECTOR_MANIFESTS[data.manifestId] : undefined;
  const parsed = parseNodeConfig(data.graphNodeType, data.config);

  return (
    <div style={drawerStyle} data-testid="node-drawer">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }}>
          {data.resolved ? (data.manifestName ?? 'Unconfigured') : (data.unknownReason ?? 'Unknown')}
        </span>
        <button type="button" aria-label="Close" onClick={onClose} style={{ border: 'none', background: 'none', color: 'var(--ink4)', cursor: 'pointer', fontSize: 14, padding: 0 }}>
          {'\u2715'}
        </button>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--ink4)', marginBottom: 16 }}>
        {data.graphNodeType}
        {data.connectionLabel ? ` · ${data.connectionLabel}` : ''}
      </div>

      {!data.resolved && (
        <div style={{ fontSize: 12.5, color: 'var(--ink3)', marginBottom: 16 }}>
          This node references a tool or connection that no longer exists. It can only be removed.
        </div>
      )}

      {data.resolved && data.graphNodeType !== 'transform' && !parsed.unrecognized && (
        <SourceDestForm
          config={parsed.value as SourceDestConfig}
          operations={manifest?.operations ?? ['read']}
          nodeType={data.graphNodeType === 'destination' ? 'destination' : 'source'}
          connectionId={data.connectionId}
          onChange={(next) => onConfigChange(next)}
        />
      )}

      {data.resolved && data.graphNodeType === 'destination' && !parsed.unrecognized && (
        <div style={{ borderTop: '1px solid var(--line2)', marginTop: 16, paddingTop: 16 }}>
          <MappingEditor
            config={parsed.value as SourceDestConfig}
            workflowId={workflowId}
            destNodeId={node.id}
            destConnectionId={data.connectionId}
            sourceConnectionId={upstreamSource?.connectionId}
            checkResults={checkResults}
            onChange={(next) => onConfigChange(next)}
          />
        </div>
      )}

      {data.resolved && data.graphNodeType === 'transform' && !parsed.unrecognized && (
        <TransformEditor
          config={parsed.value as TransformConfig}
          connectionId={upstreamSource?.connectionId}
          manifestId={upstreamSource?.manifestId}
          onChange={(next) => onConfigChange(next)}
        />
      )}

      {data.resolved && parsed.unrecognized && (
        <div>
          <div style={{ fontSize: 12.5, color: 'var(--warn)', marginBottom: 8 }}>
            Config from an older format — shown read-only, not modified.
          </div>
          <pre style={{ fontFamily: 'var(--font-data)', fontSize: 11.5, background: 'var(--surface2)', border: '1px solid var(--line2)', borderRadius: 6, padding: 8, whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
            {JSON.stringify(parsed.raw, null, 2)}
          </pre>
        </div>
      )}

      <div style={{ borderTop: '1px solid var(--line2)', marginTop: 20, paddingTop: 12 }}>
        <button
          type="button"
          onClick={onDelete}
          style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--bad)', background: 'var(--bad-bg)', border: '1px solid var(--bad-bd)', borderRadius: 6, padding: '6px 12px', cursor: 'pointer' }}
        >
          Delete node
        </button>
      </div>
    </div>
  );
}
