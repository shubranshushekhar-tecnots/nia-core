'use client';

import { useActionState, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CONNECTOR_MANIFESTS } from '@nia/schemas';
import type { Connection, ConnectorCatalogEntry, ConnectorInstall } from '@/lib/connections/types';
import { testConnectionAction, refreshConnectionSchemaAction, deleteConnectionAction, uninstallConnectorAction } from '@/lib/connections/actions';
import { CATALOG_ORDER, CONNECTOR_CATALOG_META, catalogIndexLabel } from '@/lib/connections/catalogMeta';
import { relativeTime } from '@/lib/time';
import type { ConnectionHealth, ConnectorCategory } from './styles';
import {
  categoryDotColor,
  connectionsAvailableGridStyle,
  connectionsBadgeDotStyle,
  connectionsBadgeHandleStyle,
  connectionsBadgeLinkStyle,
  connectionsBadgeMetaStyle,
  connectionsBadgeStyle,
  connectionsBadgesRowStyle,
  connectionsEmptyResultsStyle,
  connectionsFilterListStyle,
  connectionsFilterPillStyle,
  connectionsHealthDotStyle,
  connectionsHealthDotsStyle,
  connectionsHealthStripStyle,
  connectionsProviderActionsStyle,
  connectionsProviderIconStyle,
  connectionsProviderListStyle,
  connectionsProviderMetaStyle,
  connectionsProviderNameColStyle,
  connectionsProviderNameStyle,
  connectionsProviderRowStyle,
  connectionsSearchBoxStyle,
  connectionsSectionHeaderStyle,
  connectionsSectionMetaStyle,
  connectionsSectionTitleStyle,
  connectionsSubtitleStyle,
  connectionsToolbarRowStyle,
  connectionsUninstallBtnStyle,
  connectionsUploadBtnStyle,
  connectionsUploadIconStyle,
  connectionsUploadRowStyle,
  pageEmptyCardStyle,
  pageTitleStyle,
} from './styles';
import DeleteConfirmDialog from './DeleteConfirmDialog';
import EditConnectionDialog from './EditConnectionDialog';
import ConnectorCard from './ConnectorCard';
import ConnectorLogo from './ConnectorLogo';
import ConnectPanel from './ConnectPanel';

type ConnectionBadge = {
  id: string;
  handle: string;
  owner: string;
  health: ConnectionHealth;
  latencyMs?: number;
  errorNote?: string;
};

type Provider = {
  id: string;
  installId: string;
  name: string;
  initials: string;
  version: string;
  lastUsed: string;
  category: ConnectorCategory;
  connections: ConnectionBadge[];
};

// The manifest's own category enum (database/server/product/ai_vector/bi/
// files) predates and doesn't line up 1:1 with this page's design-derived
// ConnectorCategory — every shipped manifest is "database" today, so this
// only matters once a non-database manifest ships.
function mapManifestCategory(category: string): ConnectorCategory {
  switch (category) {
    case 'server':
      return 'warehouses';
    case 'bi':
      return 'bi';
    case 'ai_vector':
      return 'ai-vector';
    case 'files':
      return 'files';
    default:
      return 'databases';
  }
}

const CATEGORY_LABEL: Record<ConnectorCategory, string> = {
  databases: 'Databases',
  warehouses: 'Warehouses',
  bi: 'BI',
  'ai-vector': 'AI vector',
  files: 'Files',
};

const CATEGORIES: ConnectorCategory[] = ['databases', 'warehouses', 'bi', 'ai-vector', 'files'];

function badgeLabel(health: ConnectionHealth) {
  if (health === 'idle') return 'idle';
  return null;
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
      <button type="submit" disabled={pending} style={connectionsBadgeLinkStyle}>
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

export default function ConnectionsClient({
  currentUserId,
  catalog,
  installs,
  connections,
}: {
  currentUserId: string;
  catalog: ConnectorCatalogEntry[];
  installs: ConnectorInstall[];
  connections: Connection[];
}) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<ConnectorCategory | 'all'>('all');
  const [dialog, setDialog] = useState<
    | { type: 'delete'; connectionId: string; handle: string }
    | { type: 'uninstall'; installId: string; name: string }
    | null
  >(null);
  const [editingConnectionId, setEditingConnectionId] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Condition #5: "/" focuses search, everywhere except while the user is
  // already typing into a field (an input/textarea/contenteditable, or any
  // open modal's own fields — ConnectPanel/EditConnectionDialog render over
  // this page rather than unmounting it).
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

  /**
   * Bug 1 (condition #4 — explain, don't fix): PROVIDERS is keyed off
   * `installs`, not `connections`, so a connector with `connections` rows
   * but no matching `connector_installs` row for the CURRENT actor scope
   * is invisible here even though its data still exists.
   *
   * This can't happen through the normal create/uninstall paths — both are
   * scope-guarded:
   *   - create requires a connector_installs row in the SAME scope at
   *     creation time (apps/api/src/services/connections.ts:193-202,
   *     NOT_INSTALLED).
   *   - uninstall refuses while any connection in the SAME scope still
   *     references the connector (apps/api/src/services/connectors.ts:
   *     123-137, CONNECTOR_IN_USE).
   * Both guards filter by `workspaceWhere(scope, ...)`
   * (apps/api/src/lib/workspaceScope.ts:13-15), where scope is
   * `{ orgId }` if the actor currently has an org, else `{ ownerId }`.
   * Neither `connections` nor `connector_installs` has a scope-independent
   * link between them (connector_id is a free-text slug, not a foreign
   * key — see connections.ts:190-192's own comment) — each row's org_id/
   * owner_id is fixed at the moment IT was written, independently.
   *
   * So the only way to reach this state is a scope mismatch between when
   * the connection was created and when it's later viewed: an install and
   * its connection both written under one scope (e.g. a personal
   * workspace, `{ ownerId }`), where the connection's `connections` row
   * survives but the actor's *current* effective scope has since changed
   * (e.g. they've joined/switched into an org, so every query now runs
   * under `{ orgId }` instead) — that connection is still there, but
   * `workspaceWhere` on `connector_installs` for the new scope returns no
   * rows for that connector_id, even though a `connections` row (written
   * under the old scope) still exists. The individual-workspace migrations
   * (0003_owner_enum_value.sql, 0004_owner_rename.sql,
   * 0005_individual_workspace.sql) are the most likely place this
   * scope value could have shifted under an existing row without both
   * tables being backfilled together — not confirmed against a real
   * broken row, just the only mechanism the guards above leave open.
   */
  const PROVIDERS: Provider[] = useMemo(() => {
    return installs.map((install) => {
      const catalogEntry = catalog.find((c) => c.id === install.connectorId);
      const providerConnections = connections.filter((c) => c.connectorId === install.connectorId);
      const lastUsedAt = providerConnections
        .map((c) => c.lastUsedAt)
        .filter((v): v is string => Boolean(v))
        .sort()
        .pop();

      return {
        id: install.connectorId,
        installId: install.id,
        name: catalogEntry?.name ?? install.connectorId,
        initials: (catalogEntry?.name ?? install.connectorId).slice(0, 2),
        version: catalogEntry?.version ?? '',
        lastUsed: lastUsedAt ? relativeTime(lastUsedAt) : 'never used',
        category: mapManifestCategory(catalogEntry?.category ?? 'database'),
        connections: providerConnections.map((c) => ({
          id: c.id,
          handle: c.handle,
          owner: c.ownerUserId === currentUserId ? 'you' : '',
          health: (c.lastTestStatus === 'ok' ? 'ok' : c.lastTestStatus === 'error' ? 'error' : 'idle') as ConnectionHealth,
          latencyMs: c.lastTestLatencyMs ?? undefined,
          errorNote: c.lastTestStatus === 'error' ? 'test failed' : undefined,
        })),
      };
    });
  }, [installs, catalog, connections, currentUserId]);

  const installedIds = useMemo(() => new Set(installs.map((i) => i.connectorId)), [installs]);

  // Condition #2: catalog grid is driven entirely by catalogMeta.ts's
  // static 12-connector list — its `comingSoon` flag is the single source
  // of truth for which cards render "Connect" vs "SOON"/roadmap (only the
  // 4 ids with real manifests in registry.ts are `comingSoon: false`).
  // Already-installed real connectors drop out of the grid (they're in the
  // "Connected" section above; adding a 2nd+ connection to an already-
  // installed connector stays canvas-only, per condition #1).
  const catalogEntries = useMemo(
    () =>
      CATALOG_ORDER.map((id) => CONNECTOR_CATALOG_META[id]!).filter(
        (meta) => meta.comingSoon || !installedIds.has(meta.id),
      ),
    [installedIds],
  );

  const totalConnections = PROVIDERS.reduce((n, p) => n + p.connections.length, 0);
  const healthy = PROVIDERS.reduce((n, p) => n + p.connections.filter((c) => c.health === 'ok').length, 0);
  const idle = PROVIDERS.reduce((n, p) => n + p.connections.filter((c) => c.health === 'idle').length, 0);
  const needsAttention = PROVIDERS.reduce((n, p) => n + p.connections.filter((c) => c.health === 'error').length, 0);
  const healthDots = PROVIDERS.flatMap((p) => p.connections.map((c) => c.health));

  const filteredProviders = useMemo(() => {
    const q = search.trim().toLowerCase();
    return PROVIDERS.filter((p) => {
      if (category !== 'all' && p.category !== category) return false;
      if (q && !p.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [PROVIDERS, search, category]);

  const filteredCatalog = useMemo(() => {
    const q = search.trim().toLowerCase();
    return catalogEntries.filter((c) => {
      if (category !== 'all' && c.category !== category) return false;
      if (q && !c.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [catalogEntries, search, category]);

  const connectingMeta = connectingId ? CONNECTOR_CATALOG_META[connectingId] : undefined;

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={pageTitleStyle}>Connections</span>
        <span style={connectionsSubtitleStyle}>
          Everything your data can flow through {'\u2014'} connected sources first, the rest below.
        </span>
      </div>

      <div style={connectionsHealthStripStyle}>
        <div style={connectionsHealthDotsStyle}>
          {healthDots.map((h, i) => (
            <span key={i} style={connectionsHealthDotStyle(h)} />
          ))}
        </div>
        <span>
          <strong style={{ color: 'var(--text)' }}>{totalConnections} connections</strong> · {healthy} healthy · {idle} idle ·{' '}
          <span style={{ color: needsAttention > 0 ? 'var(--bad)' : undefined, fontWeight: needsAttention > 0 ? 600 : 400 }}>
            {needsAttention} needs attention
          </span>
        </span>
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
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: categoryDotColor(c), flex: 'none' }} />
              {CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={connectionsSectionHeaderStyle}>
          <span style={connectionsSectionTitleStyle}>Connected</span>
          <span style={connectionsSectionMetaStyle}>
            {filteredProviders.length} of {PROVIDERS.length} providers · {filteredProviders.reduce((n, p) => n + p.connections.length, 0)} connections
          </span>
        </div>

        {filteredProviders.length === 0 ? (
          <div style={pageEmptyCardStyle}>
            {PROVIDERS.length === 0 ? 'No connectors installed yet — install one below to get started.' : 'No connected providers match this filter.'}
          </div>
        ) : (
          <div style={connectionsProviderListStyle}>
            {filteredProviders.map((p) => (
              <div key={p.id} style={connectionsProviderRowStyle(true)}>
                <span style={connectionsProviderIconStyle}>
                  <ConnectorLogo id={p.id} size={18} />
                </span>
                <span style={connectionsProviderNameColStyle}>
                  <span style={connectionsProviderNameStyle}>{p.name}</span>
                  <span style={connectionsProviderMetaStyle}>
                    {p.version} · {p.connections.length} connection{p.connections.length === 1 ? '' : 's'} · last used {p.lastUsed}
                  </span>
                </span>
                <div style={connectionsBadgesRowStyle}>
                  {p.connections.map((c) => (
                    <span key={c.handle} data-testid={`connection-badge-${c.handle}`} style={connectionsBadgeStyle(c.health)}>
                      <span style={connectionsBadgeDotStyle(c.health)} />
                      <span style={connectionsBadgeHandleStyle}>{c.handle}</span>
                      {c.errorNote ? <span style={connectionsBadgeMetaStyle}>{'\u2014'} {c.errorNote}</span> : null}
                      {c.latencyMs !== undefined && <span style={connectionsBadgeMetaStyle}>{c.latencyMs}ms</span>}
                      {badgeLabel(c.health) && <span style={connectionsBadgeMetaStyle}>{badgeLabel(c.health)}</span>}
                      {c.owner && <span style={connectionsBadgeMetaStyle}>{c.owner}</span>}
                      <TestButton connectionId={c.id} />
                      <RefreshSchemaButton connectionId={c.id} />
                      <button type="button" style={connectionsBadgeLinkStyle} onClick={() => setEditingConnectionId(c.id)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        style={connectionsBadgeLinkStyle}
                        onClick={() => setDialog({ type: 'delete', connectionId: c.id, handle: c.handle })}
                      >
                        Delete
                      </button>
                    </span>
                  ))}
                </div>
                <div style={connectionsProviderActionsStyle}>
                  <span style={connectionsProviderMetaStyle} title="Right-click this connector's node in a workflow canvas">
                    Add a connection from the canvas
                  </span>
                  <span style={connectionsProviderMetaStyle} title="Grant/revoke write access from a destination node's drawer in a workflow canvas">
                    Manage write access from the canvas
                  </span>
                  <button
                    type="button"
                    style={connectionsUninstallBtnStyle}
                    onClick={() => setDialog({ type: 'uninstall', installId: p.installId, name: p.name })}
                  >
                    Uninstall
                  </button>
                </div>
              </div>
            ))}

            <div style={connectionsUploadRowStyle}>
              <span style={connectionsUploadIconStyle}>{'\u25a4'}</span>
              <span style={connectionsProviderNameColStyle}>
                <span style={connectionsProviderNameStyle}>Upload CSV / Excel</span>
                <span style={connectionsProviderMetaStyle}>Drop a one-off file and query it like any other source.</span>
              </span>
              <div style={connectionsProviderActionsStyle}>
                <button type="button" style={connectionsUploadBtnStyle} disabled title="Coming soon">
                  {'\u21a5'} Choose a file
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={connectionsSectionHeaderStyle}>
          <span style={connectionsSectionTitleStyle}>Available</span>
          <span style={connectionsSectionMetaStyle}>{filteredCatalog.length} connectors</span>
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
                onConnect={meta.comingSoon ? undefined : () => setConnectingId(meta.id)}
              />
            ))}
          </div>
        )}
      </div>

      {connectingId &&
        connectingMeta &&
        (() => {
          const manifest = CONNECTOR_MANIFESTS[connectingId];
          if (!manifest) return null;
          return (
            <ConnectPanel
              connectorId={connectingId}
              connectorName={connectingMeta.name}
              configSchema={manifest.configSchema}
              onClose={() => setConnectingId(null)}
            />
          );
        })()}

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
