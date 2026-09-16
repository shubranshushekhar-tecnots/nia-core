'use client';

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
 * Palette = CONNECTOR_MANIFESTS (static import, no fetch) x the workspace's
 * actual connections (TanStack-Query-held list, passed down as a prop),
 * joined here: a connection whose manifest has 'etl_source' -> a draggable
 * Source entry, 'etl_sink' -> a draggable Destination entry. None of the 3
 * shipped manifests are etl_sink today, so that group renders empty — by
 * design (adding a sink-capable connector lights this up with zero canvas
 * changes). One static Transform entry always shown (no manifest/connection
 * backing it — a bare, not-yet-wired node per GraphNode's own optionality).
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

export default function PaletteDock({ connections, onClose }: { connections: Connection[]; onClose: () => void }) {
  const entries = buildEntries(connections);
  const groups = ['Sources', 'Transforms', 'Destinations'].filter((g) => entries.some((e) => e.group === g));

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.28)', display: 'flex', justifyContent: 'flex-end', zIndex: 40 }}
      onClick={onClose}
    >
      <div
        style={{ width: 300, height: '100%', background: 'var(--surface)', borderLeft: '1px solid var(--line2)', padding: 16, overflowY: 'auto', boxSizing: 'border-box' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink)', marginBottom: 12 }}>Add a node</div>
        {groups.map((group) => (
          <div key={group} style={{ marginBottom: 14 }}>
            <div
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                color: 'var(--ink4)',
                textTransform: 'uppercase',
                letterSpacing: '.04em',
                marginBottom: 6,
              }}
            >
              {group}
            </div>
            {entries
              .filter((e) => e.group === group)
              .map((entry, i) => (
                <div
                  key={`${entry.graphNodeType}-${entry.manifestId ?? 'none'}-${entry.connectionId ?? i}`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(PALETTE_DRAG_MIME, JSON.stringify(entry));
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: '1px solid var(--line2)',
                    background: 'var(--surface)',
                    fontSize: 13.5,
                    color: 'var(--ink)',
                    cursor: 'grab',
                    marginBottom: 6,
                  }}
                >
                  {entry.label}
                </div>
              ))}
            {entries.filter((e) => e.group === group).length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--ink4)' }}>None available yet.</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
