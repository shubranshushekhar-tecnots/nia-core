'use client';

import { useActionState, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { Connection, ConnectorCatalogEntry, ConnectorInstall } from '@/lib/connections/types';
import { connectionRegion } from '@/lib/connections/types';
import type { WriteGrant } from '@/lib/api/connectionsClient';
import { summarizeGrants } from '@/lib/connections/grantsSummary';
import {
  testConnectionAction,
  refreshConnectionSchemaAction,
  deleteConnectionAction,
  uninstallConnectorAction,
  installConnectorAction,
} from '@/lib/connections/actions';
import { CATALOG_ORDER, CONNECTOR_CATALOG_META, catalogIndexLabel } from '@/lib/connections/catalogMeta';
import { relativeTime } from '@/lib/time';
import type { ConnectionHealth, ConnectorCategory } from './styles';
import {
  healthDotColor,
  connectionsAvailableGridStyle,
  connectionsBadgeLinkStyle,
  connectionsBadgeMetaStyle,
  connectionsCatalogHintStyle,
  connectionsEmptyPanelStyle,
  connectionsEmptyResultsStyle,
  connectionsEmptyStepStyle,
  connectionsEmptyStepNumStyle,
  connectionsEmptyStepsColStyle,
  connectionsEmptySuggestColStyle,
  connectionsFilterListStyle,
  connectionsFilterPillStyle,
  connectionsHeaderButtonsStyle,
  connectionsHealthFilterBtnStyle,
  connectionsHealthFilterRowStyle,
  connectionsPageHeaderStyle,
  connectionsRequestBtnStyle,
  connectionsSearchBoxStyle,
  connectionsSectionHeaderStyle,
  connectionsSectionMetaStyle,
  connectionsSectionTitleStyle,
  connectionsSubtitleStyle,
  connectionsTableActionsCellStyle,
  connectionsTableCardStyle,
  connectionsTableConnCellStyle,
  connectionsTableHeadRowStyle,
  connectionsTableHostStyle,
  connectionsTableMenuBtnStyle,
  connectionsTableMenuItemStyle,
  connectionsTableMenuStyle,
  connectionsTableRowStyle,
  connectionsTableStyle,
  connectionsTableTdStyle,
  connectionsTableThStyle,
  connectionsTableTileStyle,
  connectionsToolbarRowStyle,
  pageTitleStyle,
} from './styles';
import DeleteConfirmDialog from './DeleteConfirmDialog';
import EditConnectionDialog from './EditConnectionDialog';
import ConnectorCard from './ConnectorCard';
import ConnectorLogo from './ConnectorLogo';

const CATEGORY_LABEL: Record<ConnectorCategory, string> = {
  databases: 'Databases',
  warehouses: 'Warehouses',
  bi: 'BI',
  'ai-vector': 'AI vector',
  files: 'Files',
};

const CATEGORIES: ConnectorCategory[] = ['databases', 'warehouses', 'bi', 'ai-vector', 'files'];

const HEALTH_FILTERS: { key: ConnectionHealth | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'ok', label: 'Healthy' },
  { key: 'idle', label: 'Idle' },
  { key: 'error', label: 'Needs attention' },
];

function healthLabel(health: ConnectionHealth): string {
  if (health === 'ok') return 'Healthy';
  if (health === 'error') return 'Needs attention';
  return 'Idle';
}

function TestButton({ connectionId }: { connectionId: string }) {
  const [state, formAction, pending] = useActionState(testConnectionAction.bind(null, connectionId), null);
  return (
    <form action={formAction} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button type="submit" disabled={pending} style={connectionsBadgeLinkStyle}>
        {pending ? 'Testing\u2026' : 'Test'}
      </button>
      {state?.error && <ActionErrorDetail error={state.error} fix={state.errorFix} details={state.errorDetails} />}
    </form>
  );
}

// Phase 5 Session 5, Block 2 — busts both the Express and worker schema
// caches (see connections/actions.ts's refreshConnectionSchemaAction header
// comment) so a since-drifted field is picked up by the next "Run checks"
// and the next time a destination drawer's field pickers load.
function RefreshSchemaButton({ connectionId }: { connectionId: string }) {
  const [state, formAction, pending] = useActionState(refreshConnectionSchemaAction.bind(null, connectionId), null);
  return (
    <form action={formAction} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button type="submit" disabled={pending} style={connectionsTableMenuItemStyle}>
        {pending ? 'Refreshing\u2026' : 'Refresh schema'}
      </button>
      {state?.error && <ActionErrorDetail error={state.error} fix={state.errorFix} details={state.errorDetails} />}
    </form>
  );
}

/**
 * Item 5 (fix-chain plan): renders the friendly `error` summary inline, plus
 * the raw `details` (original driver/connector text) behind a "Show
 * details" toggle when present and distinct from the summary — never
 * dropped, just not shown by default. Learning-mode plan, Layer 3: `fix`
 * (from friendlyAppError/friendlyConnectionError) renders between the
 * summary and the "Show details" toggle when present.
 */
function ActionErrorDetail({ error, fix, details }: { error: string; fix?: string; details?: string }) {
  return (
    <span style={connectionsBadgeMetaStyle}>
      {'\u2014'} {error}
      {fix && <span style={{ display: 'block' }}>{fix}</span>}
      {details && details !== error && (
        <details style={{ display: 'inline', marginLeft: 4 }}>
          <summary style={{ display: 'inline', cursor: 'pointer' }}>Show details</summary>
          <span style={{ display: 'block', marginTop: 2 }}>{details}</span>
        </details>
      )}
    </span>
  );
}

/**
 * Learning mode, Step 7 — read-only write-access summary for one
 * connection, from the same GET /connections/:id/grants payload
 * NodeDrawer.tsx's canvas UI uses (batch-fetched server-side in page.tsx
 * here instead, since this page has no react-query provider). `grants ===
 * null` means that connection's grants fetch failed on the server — kept
 * strictly distinct from a real empty array (0 grants); a load failure
 * always shows a message, never gets collapsed into "no write grants".
 */
function WriteAccessStatus({ grants }: { grants: WriteGrant[] | null }) {
  if (grants === null) {
    return <span style={{ ...connectionsBadgeMetaStyle, color: 'var(--bad)' }}>Couldn&apos;t load write-access status</span>;
  }
  if (grants.length === 0) {
    return <span style={connectionsBadgeMetaStyle}>No write grants</span>;
  }
  const { confirmedCount, rows } = summarizeGrants(grants);
  return (
    <details style={{ display: 'inline' }}>
      <summary style={{ display: 'inline', cursor: 'pointer', ...connectionsBadgeMetaStyle }}>
        {confirmedCount} confirmed write grant{confirmedCount === 1 ? '' : 's'}
      </summary>
      <span style={{ display: 'block', marginTop: 2 }}>
        {rows.map((r) => (
          <span key={r.id} style={{ display: 'block', ...connectionsBadgeMetaStyle }}>
            {r.namespaces.join(', ') || '(no namespace)'} {'\u2014'} {r.writeRoleName ?? 'no role'} {'\u2014'} {r.status}
          </span>
        ))}
      </span>
    </details>
  );
}

// One "Install" form for the empty-state's suggested-connectors list — the
// exact same installConnectorAction the catalog grid's ConnectorCard uses,
// just rendered compactly since the full card doesn't fit a 2-column panel.
function SuggestedConnectorRow({ id, name, onInstalled }: { id: string; name: string; onInstalled: (connectorId: string) => void }) {
  const [state, formAction, pending] = useActionState(installConnectorAction.bind(null, id), null);
  useEffect(() => {
    if (state?.success) onInstalled(id);
  }, [state, id, onInstalled]);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={connectionsTableTileStyle}>
        <ConnectorLogo id={id} size={18} />
      </span>
      <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', flex: 1 }}>{name}</span>
      <form action={formAction}>
        <button type="submit" disabled={pending} style={connectionsRequestBtnStyle}>
          {pending ? 'Installing\u2026' : 'Install'}
        </button>
      </form>
      {state?.error && <ActionErrorDetail error={state.error} fix={state.errorFix} details={state.errorDetails} />}
    </div>
  );
}

// The row menu's outside-click handler needs a stable way to scope clicks
// to the currently-open menu without a per-row ref map; a data attribute
// keyed by the open row's own id is simpler than tracking N refs.
function RowMenu({ rowKey, open, onToggle, children }: { rowKey: string; open: boolean; onToggle: (key: string | null) => void; children: ReactNode }) {
  return (
    <div data-row-menu={rowKey} style={{ position: 'relative' }}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        style={connectionsTableMenuBtnStyle}
        onClick={() => onToggle(open ? null : rowKey)}
      >
        {'\u22ef'}
      </button>
      {open && (
        <div role="menu" style={connectionsTableMenuStyle}>
          {children}
        </div>
      )}
    </div>
  );
}

type ConnectionRow = {
  kind: 'connection';
  key: string;
  connectorId: string;
  providerName: string;
  connection: Connection;
  health: ConnectionHealth;
};

type EmptyProviderRow = {
  kind: 'empty';
  key: string;
  connectorId: string;
  providerName: string;
  installId: string;
};

export default function ConnectionsClient({
  currentUserId: _currentUserId,
  catalog,
  installs,
  connections,
  grantsByConnection,
}: {
  currentUserId: string;
  catalog: ConnectorCatalogEntry[];
  installs: ConnectorInstall[];
  connections: Connection[];
  grantsByConnection: Record<string, WriteGrant[] | null>;
}) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<ConnectorCategory | 'all'>('all');
  const [healthFilter, setHealthFilter] = useState<ConnectionHealth | 'all'>('all');
  const [openMenuRowId, setOpenMenuRowId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    | { type: 'delete'; connectionId: string; handle: string }
    | { type: 'uninstall'; installId: string; name: string }
    | null
  >(null);
  const [editingConnectionId, setEditingConnectionId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Install flow: a real connector card installs directly (no credentials
  // form on this page — adding a connection is canvas-only, per the
  // intended product model). Once installConnectorAction succeeds and the
  // revalidated `installs` prop includes the connector, scroll to its row
  // and briefly highlight it.
  const providerRowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});
  const [pendingScrollId, setPendingScrollId] = useState<string | null>(null);
  const [highlightedProviderId, setHighlightedProviderId] = useState<string | null>(null);

  // Condition #5: "/" focuses search, everywhere except while the user is
  // already typing into a field (an input/textarea/contenteditable, or any
  // open modal's own fields — EditConnectionDialog renders over this page
  // rather than unmounting it).
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== '/') return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      e.preventDefault();
      searchRef.current?.focus();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Closes the open "\u22ef" row menu on outside click or Escape.
  useEffect(() => {
    if (!openMenuRowId) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest(`[data-row-menu="${openMenuRowId}"]`)) setOpenMenuRowId(null);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpenMenuRowId(null);
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [openMenuRowId]);

  /**
   * Condition #6 fix: the table is now built primarily from `connections`
   * (every real connection always gets a row, regardless of whether its
   * `connector_installs` row is visible in the current actor scope — see
   * providers.ts's header comment for the scope-mismatch mechanism this
   * closes), with installed-but-connectionless connectors appended after so
   * a fresh install still shows up immediately (rule: "the connector
   * appears under Your connections/Connected at the top").
   */
  const rows: (ConnectionRow | EmptyProviderRow)[] = useMemo(() => {
    const out: (ConnectionRow | EmptyProviderRow)[] = [];
    for (const c of connections) {
      const meta = CONNECTOR_CATALOG_META[c.connectorId];
      const catalogEntry = catalog.find((ce) => ce.id === c.connectorId);
      const health: ConnectionHealth = c.lastTestStatus === 'ok' ? 'ok' : c.lastTestStatus === 'error' ? 'error' : 'idle';
      out.push({
        kind: 'connection',
        key: c.id,
        connectorId: c.connectorId,
        providerName: meta?.name ?? catalogEntry?.name ?? c.connectorId,
        connection: c,
        health,
      });
    }
    const connectedConnectorIds = new Set(connections.map((c) => c.connectorId));
    for (const install of installs) {
      if (connectedConnectorIds.has(install.connectorId)) continue;
      const meta = CONNECTOR_CATALOG_META[install.connectorId];
      const catalogEntry = catalog.find((ce) => ce.id === install.connectorId);
      out.push({
        kind: 'empty',
        key: install.id,
        connectorId: install.connectorId,
        providerName: meta?.name ?? catalogEntry?.name ?? install.connectorId,
        installId: install.id,
      });
    }
    return out;
  }, [connections, installs, catalog]);

  // Ref/highlight target for a connectorId is the first row belonging to
  // it, whichever kind that turns out to be.
  const firstRowKeyByConnector = useMemo(() => {
    const seen = new Set<string>();
    const map: Record<string, string> = {};
    for (const r of rows) {
      if (!seen.has(r.connectorId)) {
        seen.add(r.connectorId);
        map[r.connectorId] = r.key;
      }
    }
    return map;
  }, [rows]);

  const installedIds = useMemo(() => new Set(installs.map((i) => i.connectorId)), [installs]);
  const installIdByConnector = useMemo(() => new Map(installs.map((i) => [i.connectorId, i.id])), [installs]);

  // Catalog grid is driven entirely by catalogMeta.ts's static 12-connector
  // list — its `comingSoon` flag is the single source of truth for which
  // cards render "Install"/"SOON"/roadmap (only the 4 ids with real
  // manifests in registry.ts are `comingSoon: false`).
  const catalogEntries = useMemo(() => CATALOG_ORDER.map((id) => CONNECTOR_CATALOG_META[id]!), []);
  const realCatalogEntries = useMemo(() => catalogEntries.filter((c) => !c.comingSoon), [catalogEntries]);

  // Once installConnectorAction succeeds (ConnectorCard's onInstalled) and
  // the server-revalidated `installs` prop actually includes the connector,
  // scroll its row into view and briefly highlight it.
  useEffect(() => {
    if (!pendingScrollId || !installedIds.has(pendingScrollId)) return;
    const id = pendingScrollId;
    setPendingScrollId(null);
    providerRowRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedProviderId(id);
    const timer = setTimeout(() => setHighlightedProviderId((current) => (current === id ? null : current)), 1800);
    return () => clearTimeout(timer);
  }, [installedIds, pendingScrollId]);

  const healthy = connections.filter((c) => c.lastTestStatus === 'ok').length;
  const idle = connections.filter((c) => c.lastTestStatus === null).length;
  const needsAttention = connections.filter((c) => c.lastTestStatus === 'error').length;

  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (healthFilter === 'all') return true;
      if (r.kind === 'empty') return false;
      return r.health === healthFilter;
    });
  }, [rows, healthFilter]);

  const filteredCatalog = useMemo(() => {
    const q = search.trim().toLowerCase();
    return catalogEntries.filter((c) => {
      if (category !== 'all' && c.category !== category) return false;
      if (q && !c.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [catalogEntries, search, category]);

  // No connectors installed at all yet — show the getting-started panel
  // instead of an empty table (see "Connections — no connections yet").
  const showEmptyState = installs.length === 0;

  return (
    <>
      <div style={connectionsPageHeaderStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={pageTitleStyle}>Connections</span>
          <span style={connectionsSubtitleStyle}>The databases, warehouses and tools your workflows read from and write to.</span>
        </div>
        <div style={connectionsHeaderButtonsStyle}>
          {/* No request-a-connector endpoint exists yet — inert like the
              Upload CSV button below, not wired to an invented action. */}
          <button type="button" style={connectionsRequestBtnStyle} disabled title="Coming soon">
            Request a connector
          </button>
        </div>
      </div>

      {showEmptyState ? (
        <div style={connectionsEmptyPanelStyle}>
          <div style={connectionsEmptyStepsColStyle}>
            <span style={connectionsSectionTitleStyle}>Get started</span>
            <div style={connectionsEmptyStepStyle}>
              <span style={connectionsEmptyStepNumStyle}>1</span>
              <span style={connectionsSectionMetaStyle}>Install a connector below.</span>
            </div>
            <div style={connectionsEmptyStepStyle}>
              <span style={connectionsEmptyStepNumStyle}>2</span>
              <span style={connectionsSectionMetaStyle}>Open a workflow canvas.</span>
            </div>
            <div style={connectionsEmptyStepStyle}>
              <span style={connectionsEmptyStepNumStyle}>3</span>
              <span style={connectionsSectionMetaStyle}>Add a connection from a connector node — adding a connection always happens on the canvas.</span>
            </div>
          </div>
          <div style={connectionsEmptySuggestColStyle}>
            <span style={connectionsSectionTitleStyle}>Suggested connectors</span>
            {realCatalogEntries.map((meta) => (
              <SuggestedConnectorRow key={meta.id} id={meta.id} name={meta.name} onInstalled={setPendingScrollId} />
            ))}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ ...connectionsSectionHeaderStyle, justifyContent: 'space-between' }}>
            <span style={connectionsSectionTitleStyle}>Your connections ({connections.length})</span>
            <div style={connectionsHealthFilterRowStyle}>
              {HEALTH_FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  style={connectionsHealthFilterBtnStyle(healthFilter === f.key)}
                  onClick={() => setHealthFilter(f.key)}
                >
                  {f.key !== 'all' && <span style={{ width: 6, height: 6, borderRadius: '50%', background: healthDotColor(f.key), flex: 'none' }} />}
                  {f.label} ({f.key === 'all' ? connections.length : f.key === 'ok' ? healthy : f.key === 'idle' ? idle : needsAttention})
                </button>
              ))}
            </div>
          </div>

          {filteredRows.length === 0 ? (
            <div style={connectionsEmptyResultsStyle}>No connections match this filter.</div>
          ) : (
            <div style={connectionsTableCardStyle}>
              <table style={connectionsTableStyle}>
                <thead>
                  <tr style={connectionsTableHeadRowStyle}>
                    <th style={connectionsTableThStyle}>Connection</th>
                    <th style={connectionsTableThStyle}>Host</th>
                    <th style={connectionsTableThStyle}>Health</th>
                    <th style={connectionsTableThStyle}>Used by</th>
                    <th style={connectionsTableThStyle}>Last test</th>
                    <th style={connectionsTableThStyle} />
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row) => {
                    const isFirstForConnector = firstRowKeyByConnector[row.connectorId] === row.key;
                    const highlighted = highlightedProviderId === row.connectorId && isFirstForConnector;
                    const rowStyle = {
                      ...connectionsTableRowStyle,
                      ...(highlighted ? { background: 'color-mix(in srgb, var(--live-fill) 10%, var(--surface))', transition: 'background 1.2s ease' } : { transition: 'background 1.2s ease' }),
                    };
                    const installId = row.kind === 'empty' ? row.installId : installIdByConnector.get(row.connectorId);

                    return (
                      <tr
                        key={row.key}
                        data-testid={row.kind === 'connection' ? `connection-row-${row.connection.handle}` : `provider-row-${row.connectorId}`}
                        ref={(el) => {
                          if (isFirstForConnector) providerRowRefs.current[row.connectorId] = el;
                        }}
                        style={rowStyle}
                      >
                        <td style={connectionsTableTdStyle}>
                          <div style={connectionsTableConnCellStyle}>
                            <span style={connectionsTableTileStyle}>
                              <ConnectorLogo id={row.connectorId} size={18} />
                            </span>
                            <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                              <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>
                                {row.kind === 'connection' ? row.connection.displayName || row.connection.handle : `${row.providerName} — no connections yet`}
                              </span>
                              <span style={connectionsSectionMetaStyle}>{row.providerName}</span>
                            </span>
                          </div>
                        </td>
                        <td style={connectionsTableTdStyle}>
                          {row.kind === 'connection' && typeof row.connection.config.host === 'string' ? (
                            <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                              <span style={connectionsTableHostStyle} title={row.connection.config.host}>
                                {row.connection.config.host}
                              </span>
                              {connectionRegion(row.connection) && <span style={connectionsSectionMetaStyle}>{connectionRegion(row.connection)}</span>}
                            </span>
                          ) : (
                            <span style={connectionsSectionMetaStyle}>{'\u2014'}</span>
                          )}
                        </td>
                        <td style={connectionsTableTdStyle}>
                          {row.kind === 'connection' ? (
                            <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                <span style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: healthDotColor(row.health) }} />
                                {healthLabel(row.health)}
                              </span>
                              <WriteAccessStatus grants={grantsByConnection[row.connection.id] ?? null} />
                            </span>
                          ) : (
                            <span style={connectionsSectionMetaStyle}>{'\u2014'}</span>
                          )}
                        </td>
                        <td style={connectionsTableTdStyle}>
                          <span style={connectionsSectionMetaStyle}>{'\u2014'}</span>
                        </td>
                        <td style={connectionsTableTdStyle}>
                          <span style={connectionsSectionMetaStyle}>
                            {row.kind === 'connection' && row.connection.lastTestAt ? relativeTime(row.connection.lastTestAt) : '\u2014'}
                          </span>
                        </td>
                        <td style={connectionsTableTdStyle}>
                          <div style={connectionsTableActionsCellStyle}>
                            {row.kind === 'connection' ? (
                              <>
                                <TestButton connectionId={row.connection.id} />
                                <RowMenu rowKey={row.key} open={openMenuRowId === row.key} onToggle={setOpenMenuRowId}>
                                  <RefreshSchemaButton connectionId={row.connection.id} />
                                  <button type="button" style={connectionsTableMenuItemStyle} onClick={() => setEditingConnectionId(row.connection.id)}>
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    style={connectionsTableMenuItemStyle}
                                    onClick={() => setDialog({ type: 'delete', connectionId: row.connection.id, handle: row.connection.handle })}
                                  >
                                    Delete
                                  </button>
                                  {installId && (
                                    <button
                                      type="button"
                                      style={connectionsTableMenuItemStyle}
                                      onClick={() => setDialog({ type: 'uninstall', installId, name: row.providerName })}
                                    >
                                      Uninstall {row.providerName}
                                    </button>
                                  )}
                                </RowMenu>
                              </>
                            ) : (
                              <>
                                <span style={connectionsSectionMetaStyle} title="Right-click this connector's node in a workflow canvas">
                                  Add a connection from the canvas
                                </span>
                                <RowMenu rowKey={row.key} open={openMenuRowId === row.key} onToggle={setOpenMenuRowId}>
                                  <button
                                    type="button"
                                    style={connectionsTableMenuItemStyle}
                                    onClick={() => setDialog({ type: 'uninstall', installId: row.installId, name: row.providerName })}
                                  >
                                    Uninstall {row.providerName}
                                  </button>
                                </RowMenu>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={connectionsSectionHeaderStyle}>
          <span style={connectionsSectionTitleStyle}>Add a connection</span>
          <span style={connectionsSectionMetaStyle}>{filteredCatalog.length} connectors</span>
        </div>

        <div style={connectionsToolbarRowStyle}>
          <div style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex', alignItems: 'center' }}>
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search connectors"
              style={{ ...connectionsSearchBoxStyle, width: '100%' }}
            />
            {!search && (
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  right: 10,
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--text-4)',
                  border: '1px solid var(--line2)',
                  borderRadius: 4,
                  padding: '1px 5px',
                  pointerEvents: 'none',
                }}
              >
                /
              </span>
            )}
          </div>
          <div style={connectionsFilterListStyle} role="tablist">
            <button type="button" role="tab" aria-selected={category === 'all'} style={connectionsFilterPillStyle(category === 'all')} onClick={() => setCategory('all')}>
              All
            </button>
            {CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                role="tab"
                aria-selected={category === c}
                style={connectionsFilterPillStyle(category === c)}
                onClick={() => setCategory(c)}
              >
                {CATEGORY_LABEL[c]}
              </button>
            ))}
          </div>
        </div>

        {filteredCatalog.length === 0 ? (
          <div style={connectionsEmptyResultsStyle}>No connectors match this filter.</div>
        ) : (
          <div style={connectionsAvailableGridStyle}>
            {filteredCatalog.map((meta) => (
              <ConnectorCard
                key={meta.id}
                meta={meta}
                index={catalogIndexLabel(meta.id)}
                installed={installedIds.has(meta.id)}
                onInstalled={setPendingScrollId}
              />
            ))}
          </div>
        )}

        <span style={connectionsCatalogHintStyle}>
          Missing something?{' '}
          <button type="button" disabled title="Coming soon" style={{ ...connectionsBadgeLinkStyle, cursor: 'not-allowed' }}>
            Request a connector
          </button>
        </span>
      </div>

      {dialog?.type === 'delete' && (
        <DeleteConfirmDialog
          title="Delete connection?"
          message={`This removes ${dialog.handle} and its stored credential. This can't be undone.`}
          hiddenFields={{ id: dialog.connectionId }}
          action={deleteConnectionAction}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog?.type === 'uninstall' && (
        <DeleteConfirmDialog
          title="Uninstall connector?"
          message={`This removes ${dialog.name} from your workspace. You'll need to delete its connections first if it has any.`}
          hiddenFields={{ id: dialog.installId }}
          action={uninstallConnectorAction}
          onClose={() => setDialog(null)}
        />
      )}

      {editingConnectionId && (() => {
        const editingConnection = connections.find((c) => c.id === editingConnectionId);
        if (!editingConnection) return null;
        return (
          <EditConnectionDialog
            connection={editingConnection}
            onClose={() => setEditingConnectionId(null)}
            onSaved={() => {
              setEditingConnectionId(null);
              router.refresh();
            }}
          />
        );
      })()}
    </>
  );
}

