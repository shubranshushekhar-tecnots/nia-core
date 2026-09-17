'use client';

import { CONNECTOR_MANIFESTS, WRITE_OPERATIONS, parseNodeConfig, type Operation, type SourceDestConfig, type TransformConfig } from '@nia/schemas';
import type { CanvasNode } from '@/lib/canvas/mapping';
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

function SourceDestForm({
  config,
  operations,
  onChange,
}: {
  config: SourceDestConfig;
  operations: Operation[];
  onChange: (next: SourceDestConfig) => void;
}) {
  return (
    <div>
      <div style={sectionHeaderStyle}>Verb</div>
      {operations.map((op) => {
        const locked = WRITE_OPERATIONS.includes(op);
        return (
          <label
            key={op}
            title={locked ? 'Requires write grant — Phase 6' : undefined}
            style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: locked ? 'var(--ink4)' : 'var(--ink)', marginBottom: 6, cursor: locked ? 'not-allowed' : 'pointer' }}
          >
            <input type="radio" name="operation" disabled={locked} checked={config.operation === op} onChange={() => onChange({ operation: op })} />
            {op}
            {locked && <span style={lockedBadgeStyle}>Locked</span>}
          </label>
        );
      })}
    </div>
  );
}

export default function NodeDrawer({
  node,
  workflowId,
  upstreamSource,
  onConfigChange,
  onDelete,
  onClose,
}: {
  node: CanvasNode;
  workflowId: string;
  upstreamSource?: { connectionId?: string; manifestId?: string };
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
