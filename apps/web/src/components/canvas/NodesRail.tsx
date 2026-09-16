'use client';

import { useMemo, useState } from 'react';
import { CONNECTOR_MANIFESTS } from '@nia/schemas';
import type { Connection } from '@/lib/connections/types';
import type { GraphNodeType } from '@nia/schemas';

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

const railStyle = (wide: boolean) =>
  ({
    position: 'absolute',
    left: 16,
    top: 16,
    bottom: 16,
    width: wide ? 252 : 48,
    background: 'var(--surface)',
    border: '1px solid var(--line2)',
    borderRadius: 12,
    boxShadow: '0 4px 16px rgba(15,23,42,.10)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    zIndex: 20,
    transition: 'width 150ms ease',
  }) as const;

const sectionHeaderStyle = {
  fontSize: 11.5,
  fontWeight: 600,
  color: 'var(--ink4)',
  textTransform: 'uppercase',
  letterSpacing: '.04em',
  margin: '10px 12px 6px',
} as const;

const entryStyle = (draggable: boolean) =>
  ({
    padding: '8px 10px',
    margin: '0 10px 6px',
    borderRadius: 8,
    border: '1px solid var(--line2)',
    background: 'var(--surface)',
    fontSize: 13,
    color: draggable ? 'var(--ink)' : 'var(--ink4)',
    cursor: draggable ? 'grab' : 'not-allowed',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  }) as const;

export default function NodesRail({ connections }: { connections: Connection[] }) {
  const [wide, setWide] = useState(true);
  const [search, setSearch] = useState('');
  const entries = useMemo(() => buildEntries(connections), [connections]);
  const groups = ['Sources', 'Transforms', 'Destinations'].filter((g) => entries.some((e) => e.group === g));
  const q = search.trim().toLowerCase();

  if (!wide) {
    return (
      <div style={railStyle(false)}>
        <button
          type="button"
          aria-label="Expand nodes panel"
          onClick={() => setWide(true)}
          style={{ height: 40, border: 'none', background: 'none', color: 'var(--ink4)', cursor: 'pointer', fontSize: 14 }}
        >
          {'\u2192'}
        </button>
      </div>
    );
  }

  return (
    <div style={railStyle(true)} data-testid="nodes-rail">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 12px 8px' }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }}>Nodes</span>
        <button
          type="button"
          aria-label="Collapse nodes panel"
          onClick={() => setWide(false)}
          style={{ border: 'none', background: 'none', color: 'var(--ink4)', cursor: 'pointer', fontSize: 13, padding: 0 }}
        >
          {'\u2190'}
        </button>
      </div>

      <div style={{ padding: '0 12px 8px' }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search nodes…"
          aria-label="Search nodes"
          style={{
            width: '100%',
            height: 30,
            borderRadius: 6,
            border: '1px solid var(--line2)',
            padding: '0 8px',
            fontSize: 12.5,
            boxSizing: 'border-box',
            color: 'var(--ink)',
            background: 'var(--surface2)',
          }}
        />
      </div>

      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 8 }}>
        {(!q || 'triggers'.includes(q) || 'trigger'.includes(q)) && (
          <div>
            <div style={sectionHeaderStyle}>Triggers</div>
            <div style={entryStyle(false)} title="Requires a trigger manifest — Phase 6">
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
              <div style={sectionHeaderStyle}>{group}</div>
              {groupEntries.map((entry, i) => (
                <div
                  key={`${entry.graphNodeType}-${entry.manifestId ?? 'none'}-${entry.connectionId ?? i}`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(PALETTE_DRAG_MIME, JSON.stringify(entry));
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  style={entryStyle(true)}
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
