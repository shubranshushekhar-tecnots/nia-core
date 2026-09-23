'use client';

import { useEffect, useMemo, useState } from 'react';
import { CONNECTOR_MANIFESTS } from '@nia/schemas';
import { connectionSecondaryLabel, type Connection, type ConnectorInstall } from '@/lib/connections/types';
import type { GraphNodeType } from '@nia/schemas';
import AddConnectionDialog from '@/components/app/AddConnectionDialog';
import {
  railAddEntryStyle,
  railBodyStyle,
  railCollapseBtnStyle,
  railContextMenuItemStyle,
  railContextMenuStyle,
  railEntryConnectBadgeStyle,
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

type PaletteEntry = PaletteDragPayload & {
  group: string;
  connectorId?: string;
  connectorName?: string;
  // Item 6.2 (fix-chain plan): host/database, shown alongside displayName
  // so two connections named e.g. both "Neon Postgres" are distinguishable.
  secondaryLabel?: string;
  // Trailing "+ Add connection" row appended after a connector's real
  // connection rows, as opposed to the single not-yet-connected
  // placeholder row (which has neither connectionId nor isAddEntry set).
  isAddEntry?: boolean;
};

/**
 * Replaces PaletteDock.tsx's modal "Add node" dock with a persistent,
 * always-visible left rail (Task 1) — same entry-building logic as the old
 * dock (CONNECTOR_MANIFESTS x the workspace's actual, RLS-scoped
 * connections; no hardcoded tool list), now rendered docked instead of as
 * an overlay so drag-to-canvas doesn't require an extra open/close step.
 *
 * Nodes are now built from `connectorInstalls` (every installed connector),
 * not just `connections` — a connector shows up here the moment it's
 * installed on the Connections page, even before any connection has been
 * created for it, so "Add connection" can move here (right-click, or a
 * click on the not-yet-connected placeholder row) instead of living on the
 * Connections page. Connectors that already have connections still get one
 * draggable row per connection, same as before.
 *
 * Triggers is listed first per the plan but is not backed by any GraphNode
 * type or manifest capability yet (no trigger nodes exist this session) —
 * rendered as a single non-draggable, locked entry with a "Soon" badge
 * rather than invented functionality.
 */
function buildEntries(connections: Connection[], connectorInstalls: ConnectorInstall[]): PaletteEntry[] {
  const connectionsByConnector = new Map<string, Connection[]>();
  for (const connection of connections) {
    const list = connectionsByConnector.get(connection.connectorId) ?? [];
    list.push(connection);
    connectionsByConnector.set(connection.connectorId, list);
  }

  const entries: PaletteEntry[] = [];
  for (const install of connectorInstalls) {
    const manifest = CONNECTOR_MANIFESTS[install.connectorId];
    if (!manifest) continue;
    const manifestConnections = connectionsByConnector.get(install.connectorId) ?? [];
    const groups: { graphNodeType: GraphNodeType; group: string }[] = [];
    if (manifest.capabilities.includes('etl_source')) groups.push({ graphNodeType: 'source', group: 'Sources' });
    if (manifest.capabilities.includes('etl_sink')) groups.push({ graphNodeType: 'destination', group: 'Destinations' });

    for (const { graphNodeType, group } of groups) {
      if (manifestConnections.length > 0) {
        for (const connection of manifestConnections) {
          entries.push({
            graphNodeType,
            manifestId: manifest.id,
            connectionId: connection.id,
            label: connection.displayName,
            secondaryLabel: connectionSecondaryLabel(connection),
            group,
            connectorId: manifest.id,
            connectorName: manifest.name,
          });
        }
        // A connector with connections still needs a way to add another one
        // (e.g. a second Supabase DB) — this trailing row keeps that
        // affordance visible instead of it disappearing once connected.
        entries.push({
          graphNodeType,
          manifestId: manifest.id,
          label: `Add ${manifest.name} connection`,
          group,
          connectorId: manifest.id,
          connectorName: manifest.name,
          isAddEntry: true,
        });
      } else {
        // Installed but not connected yet — still visible so "Add
        // connection" can be triggered from this row (right-click, or a
        // direct click since there's nothing to drag yet).
        entries.push({
          graphNodeType,
          manifestId: manifest.id,
          label: manifest.name,
          group,
          connectorId: manifest.id,
          connectorName: manifest.name,
        });
      }
    }
  }
  entries.push({ graphNodeType: 'transform', label: 'Transform', group: 'Transforms' });
  return entries;
}

type MenuState = { x: number; y: number; connectorId: string; connectorName: string };

export default function NodesRail({
  connections,
  connectorInstalls,
  onConnectionCreated,
}: {
  connections: Connection[];
  connectorInstalls: ConnectorInstall[];
  onConnectionCreated: () => void;
}) {
  const [wide, setWide] = useState(true);
  const [search, setSearch] = useState('');
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [addDialogConnectorId, setAddDialogConnectorId] = useState<string | null>(null);
  const entries = useMemo(() => buildEntries(connections, connectorInstalls), [connections, connectorInstalls]);
  const groups = ['Sources', 'Transforms', 'Destinations'].filter((g) => entries.some((e) => e.group === g));
  const q = search.trim().toLowerCase();

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  function openAddConnectionMenu(e: React.MouseEvent, entry: PaletteEntry) {
    if (!entry.connectorId) return;
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, connectorId: entry.connectorId, connectorName: entry.connectorName ?? entry.label });
  }

  const addDialogManifest = addDialogConnectorId ? CONNECTOR_MANIFESTS[addDialogConnectorId] : null;

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
              {groupEntries.map((entry, i) => {
                const connected = Boolean(entry.connectionId);
                const draggable = entry.graphNodeType === 'transform' || connected;
                if (entry.isAddEntry) {
                  return (
                    <div
                      key={`${entry.graphNodeType}-${entry.manifestId ?? 'none'}-add-${i}`}
                      onContextMenu={(e) => openAddConnectionMenu(e, entry)}
                      onClick={() => entry.connectorId && setAddDialogConnectorId(entry.connectorId)}
                      style={railAddEntryStyle}
                      title={`Add another ${entry.connectorName} connection`}
                    >
                      <span style={railEntryIconTileStyle('var(--ink4)')}>+</span>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        Add connection
                      </span>
                    </div>
                  );
                }
                return (
                  <div
                    key={`${entry.graphNodeType}-${entry.manifestId ?? 'none'}-${entry.connectionId ?? i}`}
                    draggable={draggable}
                    onDragStart={(e) => {
                      if (!draggable) return;
                      e.dataTransfer.setData(PALETTE_DRAG_MIME, JSON.stringify(entry));
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onContextMenu={(e) => openAddConnectionMenu(e, entry)}
                    onClick={() => {
                      if (!connected && entry.connectorId) setAddDialogConnectorId(entry.connectorId);
                    }}
                    style={railEntryStyle(draggable)}
                    title={connected ? undefined : `${entry.connectorName} — right-click, or click, to add a connection`}
                  >
                    <span style={railEntryIconTileStyle(NODE_TYPE_COLOR[entry.graphNodeType])}>
                      {(() => {
                        const Icon = getConnectorIcon(entry.manifestId, entry.graphNodeType);
                        return <Icon size={13} />;
                      })()}
                    </span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 5,
                        overflow: 'hidden',
                      }}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.label}</span>
                      {entry.secondaryLabel && (
                        <span
                          style={{
                            flex: '0 1 auto',
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            fontSize: 10.5,
                            color: 'var(--ink4)',
                          }}
                        >
                          {entry.secondaryLabel}
                        </span>
                      )}
                    </span>
                    {!connected && entry.connectorId && <span style={railEntryConnectBadgeStyle}>Not connected</span>}
                  </div>
                );
              })}
              {!q && groupEntries.length === 0 && (
                <div style={{ fontSize: 11.5, color: 'var(--ink4)', margin: '0 12px 8px' }}>None available yet.</div>
              )}
            </div>
          );
        })}
      </div>

      {menu && (
        <div style={railContextMenuStyle(menu.x, menu.y)} onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            style={railContextMenuItemStyle}
            onClick={() => {
              setAddDialogConnectorId(menu.connectorId);
              setMenu(null);
            }}
          >
            Add connection
          </button>
        </div>
      )}

      {addDialogManifest && (
        <AddConnectionDialog
          connectorId={addDialogManifest.id}
          connectorName={addDialogManifest.name}
          configSchema={addDialogManifest.configSchema}
          onClose={() => {
            setAddDialogConnectorId(null);
            onConnectionCreated();
          }}
        />
      )}
    </div>
  );
}
