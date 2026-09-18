'use client';

import { useMemo, useState } from 'react';
import { CONNECTOR_MANIFESTS } from '@nia/schemas';
import type { Connection } from '@/lib/connections/types';
import type { GraphNodeType } from '@nia/schemas';
import {
  railBodyStyle,
  railCollapseBtnStyle,
  railCollapsedDividerStyle,
  railCollapsedEntryDotStyle,
  railCollapsedEntryLabelStyle,
  railCollapsedEntryStyle,
  railCollapsedListStyle,
  railCollapsedToggleStyle,
  railEntryStyle,
  railHeaderStyle,
  railSearchInputStyle,
  railSearchWrapStyle,
  railSectionHeaderStyle,
  railShellStyle,
} from './styles';

// Same source of truth as GraphFlowNode.tsx's KIND_COLOR — kept local since
// it's a single 3-entry map and importing it would couple this file to the
// node-rendering module for no other reason.
const NODE_TYPE_COLOR: Record<GraphNodeType, string> = {
  source: 'var(--c-data)',
  transform: 'var(--c-condition)',
  destination: 'var(--c-action)',
};

// Two-letter avatar for the icon-only collapsed rail, e.g. "Postgres Prod" -> "PP".
function initials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  if (!first) return '??';
  const second = words[1];
  if (!second) return first.slice(0, 2).toUpperCase();
  return (first.charAt(0) + second.charAt(0)).toUpperCase();
}

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

  if (!wide) {
    return (
      <div style={railShellStyle(false)} data-testid="nodes-rail">
        <button type="button" aria-label="Expand nodes panel" onClick={() => setWide(true)} style={railCollapsedToggleStyle}>
          {'\u2192'}
        </button>

        <div style={railCollapsedListStyle}>
          <div style={railCollapsedEntryStyle(false)} title="Trigger — requires a trigger manifest, coming soon">
            <span style={railCollapsedEntryLabelStyle}>TG</span>
          </div>

          {groups.map((group) => {
            const groupEntries = entries.filter((e) => e.group === group);
            if (groupEntries.length === 0) return null;
            return (
              <div key={group} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                <div style={railCollapsedDividerStyle} />
                {groupEntries.map((entry, i) => (
                  <div
                    key={`${entry.graphNodeType}-${entry.manifestId ?? 'none'}-${entry.connectionId ?? i}`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(PALETTE_DRAG_MIME, JSON.stringify(entry));
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    title={`${entry.label} (${group.slice(0, -1)})`}
                    style={railCollapsedEntryStyle(true)}
                  >
                    <span style={railCollapsedEntryLabelStyle}>{initials(entry.label)}</span>
                    <span style={railCollapsedEntryDotStyle(NODE_TYPE_COLOR[entry.graphNodeType])} />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
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
                  {entry.label}
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
