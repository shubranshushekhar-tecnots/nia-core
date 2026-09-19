'use client';

import { useMemo, useState } from 'react';
import { CONNECTOR_MANIFESTS } from '@nia/schemas';
import type { Connection } from '@/lib/connections/types';
import type { GraphNodeType } from '@nia/schemas';
import {
  railBodyStyle,
  railCollapseBtnStyle,
  railEntryIconTileStyle,
  railEntryStyle,
  railHeaderStyle,
  railReopenBtnCountStyle,
  railReopenBtnStyle,
  railSearchInputStyle,
  railSearchWrapStyle,
  railSectionHeaderStyle,
  railShellStyle,
} from './styles';
import { getConnectorIcon, TriggerIcon } from './icons';
import { PanelToggleIcon } from './navIcons';

// Same source of truth as GraphFlowNode.tsx's KIND_COLOR — kept local since
// it's a single 3-entry map and importing it would couple this file to the
// node-rendering module for no other reason.
const NODE_TYPE_COLOR: Record<GraphNodeType, string> = {
  source: 'var(--c-data)',
  transform: 'var(--c-condition)',
  destination: 'var(--c-action)',
};

export type PaletteDragPayload = {
  graphNodeType: GraphNodeType;
  manifestId?: string;
  connectionId?: string;
  label: string;
};

export const PALETTE_DRAG_MIME = 'application/nia-canvas-node';

type PaletteEntry = PaletteDragPayload & { group: string };

/**
 * Replaces PaletteDock.tsx's modal "Add node" dock with a persistent,
 * always-visible left rail (Task 1) — same entry-building logic as the old
 * dock (CONNECTOR_MANIFESTS x the workspace's actual, RLS-scoped
 * connections; no hardcoded tool list), now rendered docked instead of as
 * an overlay so drag-to-canvas doesn't require an extra open/close step.
 *
 * Triggers is listed first per the plan but is not backed by any GraphNode
 * type or manifest capability yet (no trigger nodes exist this session) —
 * rendered as a single non-draggable, locked entry with a "Soon" badge
 * rather than invented functionality.
 */
function buildEntries(connections: Connection[]): PaletteEntry[] {
  const entries: PaletteEntry[] = [];
  for (const connection of connections) {
    const manifest = CONNECTOR_MANIFESTS[connection.connectorId];
    if (!manifest) continue;
    if (manifest.capabilities.includes('etl_source')) {
      entries.push({
        graphNodeType: 'source',
        manifestId: manifest.id,
        connectionId: connection.id,
        label: connection.displayName,
        group: 'Sources',
      });
    }
    if (manifest.capabilities.includes('etl_sink')) {
      entries.push({
        graphNodeType: 'destination',
        manifestId: manifest.id,
        connectionId: connection.id,
        label: connection.displayName,
        group: 'Destinations',
      });
    }
  }
  entries.push({ graphNodeType: 'transform', label: 'Transform', group: 'Transforms' });
  return entries;
}

export default function NodesRail({ connections }: { connections: Connection[] }) {
  const [wide, setWide] = useState(true);
  const [search, setSearch] = useState('');
  const entries = useMemo(() => buildEntries(connections), [connections]);
  const groups = ['Sources', 'Transforms', 'Destinations'].filter((g) => entries.some((e) => e.group === g));
  const q = search.trim().toLowerCase();

  // Collapsed: the rail itself renders nothing (width 0, see railShellStyle)
  // — a small floating "Nodes N · +" button re-expands it instead of the
  // old icon-only strip. Positioned relative to this wrapper (which sits at
  // the very left edge of the canvas body, in the same spot the rail used
  // to occupy) so it reads as anchored to the top-left of the canvas area.
  if (!wide) {
    return (
      <div style={{ position: 'relative', flex: 'none', width: 0, height: '100%' }} data-testid="nodes-rail">
        <button type="button" onClick={() => setWide(true)} style={railReopenBtnStyle} title="Show nodes" aria-label="Show nodes">
          <PanelToggleIcon size={14} />
          Nodes
          <span style={railReopenBtnCountStyle}>{entries.length}</span>
        </button>
      </div>
    );
  }

  return (
    <div style={railShellStyle(true)} data-testid="nodes-rail">
      <div style={railHeaderStyle}>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }}>Nodes</span>
        <button type="button" aria-label="Collapse nodes panel" onClick={() => setWide(false)} style={railCollapseBtnStyle}>
          {'\u2190'}
        </button>
      </div>

      <div style={railSearchWrapStyle}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search nodes…"
          aria-label="Search nodes"
          style={railSearchInputStyle}
        />
      </div>

      <div style={railBodyStyle}>
        {(!q || 'triggers'.includes(q) || 'trigger'.includes(q)) && (
          <div>
            <div style={railSectionHeaderStyle}>Triggers</div>
            <div style={railEntryStyle(false)} title="Requires a trigger manifest — Phase 6">
              <span style={railEntryIconTileStyle('var(--ink4)')}>
                <TriggerIcon size={13} />
              </span>
              <span style={{ flex: 1 }}>Trigger</span>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: 'var(--warn)',
                  background: 'var(--warn-bg)',
                  border: '1px solid var(--warn-bd)',
                  borderRadius: 999,
                  padding: '1px 6px',
                }}
              >
                Soon
              </span>
            </div>
          </div>
        )}

        {groups.map((group) => {
          const groupEntries = entries.filter((e) => e.group === group && (!q || e.label.toLowerCase().includes(q)));
          if (q && groupEntries.length === 0) return null;
          return (
            <div key={group}>
              <div style={railSectionHeaderStyle}>{group}</div>
              {groupEntries.map((entry, i) => (
                <div
                  key={`${entry.graphNodeType}-${entry.manifestId ?? 'none'}-${entry.connectionId ?? i}`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(PALETTE_DRAG_MIME, JSON.stringify(entry));
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  style={railEntryStyle(true)}
                >
                  <span style={railEntryIconTileStyle(NODE_TYPE_COLOR[entry.graphNodeType])}>
                    {(() => {
                      const Icon = getConnectorIcon(entry.manifestId, entry.graphNodeType);
                      return <Icon size={13} />;
                    })()}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.label}
                  </span>
                </div>
              ))}
              {!q && groupEntries.length === 0 && (
                <div style={{ fontSize: 11.5, color: 'var(--ink4)', margin: '0 12px 8px' }}>None available yet.</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
