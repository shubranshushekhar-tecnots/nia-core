'use client';

import { useEffect, useMemo, useState } from 'react';
import { CONNECTOR_MANIFESTS } from '@nia/schemas';
import { connectionRegion, type Connection, type ConnectorInstall } from '@/lib/connections/types';
import type { GraphNodeType } from '@nia/schemas';
import AddConnectionDialog from '@/components/app/AddConnectionDialog';
import {
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
  source: 'var(--nx-blue-panel)',
  transform: 'var(--nx-ink)',
  destination: 'var(--nx-blue-panel)',
};

/**
 * Dual-role connections (e.g. Postgres/Supabase support both etl_source and
 * etl_sink) now drag out as ONE payload carrying every role the connector
 * supports — FlowCanvas.tsx's onDrop shows an inline "Use as Source" /
 * "Use as Destination" picker when `roles.length > 1`, and creates the node
 * straight away (same as before) when there's exactly one. No fixed
 * `graphNodeType` on the payload anymore — that was the source of the old
 * one-row-per-role duplication in this rail.
 */
export type PaletteDragPayload = {
  roles: GraphNodeType[];
  manifestId?: string;
  connectionId?: string;
  label: string;
};

export const PALETTE_DRAG_MIME = 'application/nia-canvas-node';

type PaletteEntry = PaletteDragPayload & {
  group: 'Connections' | 'Transforms';
  connectorId?: string;
  connectorName?: string;
  // "Provider · region" sub-line per the redesign spec (region best-effort,
  // regex-derived — see connectionRegion's doc comment; omitted when
  // unparseable rather than inventing one).
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
    const roles: GraphNodeType[] = [];
    if (manifest.capabilities.includes('etl_source')) roles.push('source');
    if (manifest.capabilities.includes('etl_sink')) roles.push('destination');
    if (roles.length === 0) continue;

    const manifestConnections = connectionsByConnector.get(install.connectorId) ?? [];
    if (manifestConnections.length > 0) {
      for (const connection of manifestConnections) {
        const region = connectionRegion(connection);
        entries.push({
          roles,
          manifestId: manifest.id,
          connectionId: connection.id,
          label: connection.displayName,
          secondaryLabel: region ? `${manifest.name} · ${region}` : manifest.name,
          group: 'Connections',
          connectorId: manifest.id,
          connectorName: manifest.name,
        });
      }
      // A connector with connections still needs a way to add another one
      // (e.g. a second Supabase DB) — this trailing row keeps that
      // affordance visible instead of it disappearing once connected.
      entries.push({
        roles,
        manifestId: manifest.id,
        label: `Add ${manifest.name} connection`,
        group: 'Connections',
        connectorId: manifest.id,
        connectorName: manifest.name,
        isAddEntry: true,
      });
    } else {
      // Installed but not connected yet — still visible so "Add
      // connection" can be triggered from this row (right-click, or a
      // direct click since there's nothing to drag yet).
      entries.push({
        roles,
        manifestId: manifest.id,
        label: manifest.name,
        group: 'Connections',
        connectorId: manifest.id,
        connectorName: manifest.name,
      });
    }
  }
  entries.push({ roles: ['transform'], label: 'Transform', group: 'Transforms' });
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
  // Reordered per the redesign spec: Connections -> Transforms -> Triggers
  // (Triggers is rendered separately below, last, since it's not data-driven).
  const groups = (['Connections', 'Transforms'] as const).filter((g) => entries.some((e) => e.group === g));
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
        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--nx-ink)' }}>Nodes</span>
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
        {groups.map((group) => {
          const groupEntries = entries.filter((e) => e.group === group && (!q || e.label.toLowerCase().includes(q)));
          if (q && groupEntries.length === 0) return null;
          return (
            <div key={group}>
              <div style={railSectionHeaderStyle}>{group}</div>
              {group === 'Connections' && !q && (
                <div style={{ fontSize: 11, color: 'var(--nx-ink-3)', margin: '-2px 14px 6px' }}>
                  Drag a connection onto the canvas to use it as a source or destination.
                </div>
              )}
              {groupEntries.map((entry, i) => {
                const connected = Boolean(entry.connectionId);
                const draggable = entry.roles.includes('transform') || connected;
                const primaryRole = entry.roles[0];
                const tileColor = entry.roles.length === 1 && primaryRole ? NODE_TYPE_COLOR[primaryRole] : 'var(--nx-ink-3)';
                if (entry.isAddEntry) {
                  return (
                    <button
                      key={`${entry.manifestId ?? 'none'}-add-${i}`}
                      type="button"
                      onContextMenu={(e) => openAddConnectionMenu(e, entry)}
                      onClick={() => entry.connectorId && setAddDialogConnectorId(entry.connectorId)}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        border: 'none',
                        background: 'none',
                        margin: '0 8px 4px',
                        padding: '4px 8px',
                        fontSize: 12.5,
                        fontWeight: 500,
                        color: 'var(--nx-blue-panel)',
                        cursor: 'pointer',
                      }}
                      title={`Add another ${entry.connectorName} connection`}
                    >
                      + New connection
                    </button>
                  );
                }
                return (
                  <div
                    key={`${entry.manifestId ?? 'none'}-${entry.connectionId ?? i}`}
                    draggable={draggable}
                    onDragStart={(e) => {
                      if (!draggable) return;
                      const payload: PaletteDragPayload = {
                        roles: entry.roles,
                        manifestId: entry.manifestId,
                        connectionId: entry.connectionId,
                        label: entry.label,
                      };
                      e.dataTransfer.setData(PALETTE_DRAG_MIME, JSON.stringify(payload));
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onContextMenu={(e) => openAddConnectionMenu(e, entry)}
                    onClick={() => {
                      if (!connected && entry.connectorId) setAddDialogConnectorId(entry.connectorId);
                    }}
                    style={railEntryStyle(draggable)}
                    title={connected ? undefined : `${entry.connectorName} — right-click, or click, to add a connection`}
                  >
                    <span style={railEntryIconTileStyle(tileColor, 32)}>
                      {(() => {
                        const Icon = getConnectorIcon(entry.manifestId, entry.roles[0]);
                        return <Icon size={16} />;
                      })()}
                    </span>
                    <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1, overflow: 'hidden' }}>
                      <span title={entry.label} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 500 }}>
                        {entry.label}
                      </span>
                      {entry.secondaryLabel && (
                        <span
                          style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            fontFamily: 'var(--nx-font-mono)',
                            fontSize: 10.5,
                            color: 'var(--nx-ink-3)',
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
                <div style={{ fontSize: 11.5, color: 'var(--nx-ink-disabled)', margin: '0 12px 8px' }}>None available yet.</div>
              )}
            </div>
          );
        })}

        {(!q || 'triggers'.includes(q) || 'trigger'.includes(q) || 'schedule'.includes(q)) && (
          <div>
            <div style={railSectionHeaderStyle}>Triggers</div>
            <div style={railEntryStyle(false)} title="Requires a trigger manifest — Phase 6">
              <span style={railEntryIconTileStyle('var(--nx-ink-disabled)')}>
                <TriggerIcon size={13} />
              </span>
              <span style={{ flex: 1 }}>Schedule</span>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: 'var(--nx-warn)',
                  background: 'var(--nx-raised)',
                  border: '1px solid var(--nx-warn)',
                  borderRadius: 999,
                  padding: '1px 6px',
                }}
              >
                Soon
              </span>
            </div>
          </div>
        )}
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
