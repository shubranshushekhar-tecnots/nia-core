'use client';

import { useActionState, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Connection, ConnectorCatalogEntry, ConnectorInstall } from '@/lib/connections/types';
import {
  installConnectorAction,
  testConnectionAction,
  refreshConnectionSchemaAction,
  deleteConnectionAction,
  uninstallConnectorAction,
} from '@/lib/connections/actions';
import { relativeTime } from '@/lib/time';
import type { ConnectionHealth, ConnectorCategory } from './styles';
import {
  SPHERE_DOT_COUNT,
  STACK_LAYER_COUNT,
  categoryDotColor,
  connectionsAvailableGridStyle,
  connectionsBadgeDotStyle,
  connectionsBadgeHandleStyle,
  connectionsBadgeLinkStyle,
  connectionsBadgeMetaStyle,
  connectionsBadgeStyle,
  connectionsBadgesRowStyle,
  connectionsConnectorCardHoverStyle,
  connectionsConnectorCardStyle,
  connectionsConnectorDescStyle,
  connectionsConnectorIndexStyle,
  connectionsConnectorLogoStyle,
  connectionsConnectorNameStyle,
  connectionsConnectorTagStyle,
  connectionsConnectorTagsStyle,
  connectionsEmptyResultsStyle,
  connectionsFilterListStyle,
  connectionsFilterPillStyle,
  connectionsGraphicWrapStyle,
  connectionsHealthDotStyle,
  connectionsHealthDotsStyle,
  connectionsHealthStripStyle,
  connectionsInstallBtnStyle,
  connectionsInstallLabelStyle,
  connectionsInstallRowStyle,
  connectionsProviderActionsStyle,
  connectionsProviderIconStyle,
  connectionsProviderListStyle,
  connectionsProviderMetaStyle,
  connectionsProviderNameColStyle,
  connectionsProviderNameStyle,
  connectionsProviderRowStyle,
  connectionsRoadmapIconStyle,
  connectionsRoadmapLabelStyle,
  connectionsRoadmapRowStyle,
  connectionsSearchBoxStyle,
  connectionsSectionHeaderStyle,
  connectionsSectionMetaStyle,
  connectionsSectionTitleStyle,
  connectionsSoonBadgeStyle,
  connectionsSphereDotStyle,
  connectionsSphereHighlightStyle,
  connectionsSphereMainStyle,
  connectionsStackLayerStyle,
  connectionsSubtitleStyle,
  connectionsToolbarRowStyle,
  connectionsUnavailableDescStyle,
  connectionsUnavailableGraphicStyle,
  connectionsUnavailableNameStyle,
  connectionsUninstallBtnStyle,
  connectionsUploadBtnStyle,
  connectionsUploadIconStyle,
  connectionsUploadRowStyle,
  modalErrorStyle,
  pageEmptyCardStyle,
  pageTitleStyle,
  soonBtnStyle,
} from './styles';
import DeleteConfirmDialog from './DeleteConfirmDialog';
import EditConnectionDialog from './EditConnectionDialog';
import { CONNECTOR_ICONS, getConnectorIcon } from '@/components/canvas/icons';

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

type AvailableConnector = {
  id: string;
  index: string;
  name: string;
  description: string;
  category: ConnectorCategory;
  tags: string[];
  graphic: 'cards' | 'sphere';
  real?: boolean;
  unavailable?: boolean;
};

// The manifest's own category enum (database/server/product/ai_vector/bi/
// files) predates and doesn't line up 1:1 with this page's design-derived
// ConnectorCategory — only "database" is exercised today (MySQL is the
// only real manifest); the rest fall back to "databases" until a connector
// actually needs one of them.
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

// Static copy for the real, catalog-driven "Available" cards — the API's
// /connectors catalog only returns id/name/category/version, not marketing
// copy, so this is authored the same way the 8 decorative AVAILABLE
// entries below are.
const REAL_CONNECTOR_META: Record<string, { description: string; tags: string[]; graphic: 'cards' | 'sphere' }> = {
  mysql: {
    description: 'Query tables directly with read-only credentials.',
    tags: ['credentials', 'queryable', 'etl'],
    graphic: 'cards',
  },
  mongodb: {
    description: 'Run aggregation pipelines against collections with read-only credentials.',
    tags: ['credentials', 'queryable', 'etl'],
    graphic: 'cards',
  },
  supabase: {
    description: 'Query a hosted Supabase Postgres project directly over TLS.',
    tags: ['credentials', 'queryable', 'etl'],
    graphic: 'cards',
  },
  postgres: {
    description: 'Query a self-hosted or managed Postgres database directly over TLS.',
    tags: ['credentials', 'queryable', 'etl'],
    graphic: 'cards',
  },
};

// Real vendor logo (canvas/icons.tsx's CONNECTOR_ICONS registry — same
// source used on canvas nodes) when one exists for this connector id;
// falls back to initials text for ids without a real logo yet (nothing
// today — all 3 shipped connectors have one — but future manifests may
// land before their logo does).
function ConnectorLogo({ id, size, fallback }: { id: string; size: number; fallback: string }) {
  if (!CONNECTOR_ICONS[id]) return <>{fallback}</>;
  const Icon = getConnectorIcon(id);
  return <Icon size={size} />;
}

// Decorative bottom-right graphic ported from the design: most connectors
// get the skewed "stacked cards" motif; AI-vector connectors get a sphere.
function ConnectorGraphic({ type }: { type: 'cards' | 'sphere' }) {
  return (
    <span aria-hidden="true" style={connectionsGraphicWrapStyle}>
      {type === 'cards'
        ? Array.from({ length: STACK_LAYER_COUNT }, (_, i) => <span key={i} style={connectionsStackLayerStyle(i)} />)
        : (
          <>
            <span style={connectionsSphereMainStyle} />
            <span style={connectionsSphereHighlightStyle} />
            {Array.from({ length: SPHERE_DOT_COUNT }, (_, i) => (
              <span key={i} style={connectionsSphereDotStyle(i)} />
            ))}
          </>
        )}
    </span>
  );
}

// Thin-line clock glyph for the "On the roadmap" row — matches the design's
// monochrome outline icon set better than an emoji glyph would (those render
// as colored pictographs on most platforms).
function RoadmapIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </svg>
  );
}

// None of these have a manifest in registry.ts — they are not real,
// installable tools yet, so every entry here is `unavailable: true` and
// renders the "SOON" badge / "On the roadmap" treatment instead of an
// Install control (a disabled-but-identically-styled Install button was
// previously used for these, which misleadingly looked functional next to
// real connectors). Supabase and MongoDB used to live here too, but both
// shipped real manifests in Phase 2 (see registry.ts) and now come through
// REAL_AVAILABLE below with a working Install button — kept here they'd
// render as duplicate, fake-Install cards.
const AVAILABLE: AvailableConnector[] = [
  {
    id: 'pgvector',
    index: '01',
    name: 'pgvector',
    description: 'Search embeddings stored alongside your Postgres data.',
    category: 'ai-vector',
    tags: ['credentials', 'ai vector', 'queryable'],
    graphic: 'sphere',
    unavailable: true,
  },
  {
    id: 'snowflake',
    index: '02',
    name: 'Snowflake',
    description: 'Run warehouse-scale questions without moving the data out.',
    category: 'warehouses',
    tags: ['credentials', 'warehouse', 'queryable'],
    graphic: 'cards',
    unavailable: true,
  },
  {
    id: 'bigquery',
    index: '03',
    name: 'BigQuery',
    description: 'Query datasets in place and cite the tables behind each answer.',
    category: 'warehouses',
    tags: ['oauth', 'warehouse', 'queryable'],
    graphic: 'cards',
    unavailable: true,
  },
  {
    id: 'looker',
    index: '04',
    name: 'Looker',
    description: 'Pull explores and dashboards into a workflow as a source.',
    category: 'bi',
    tags: ['oauth', 'queryable'],
    graphic: 'cards',
    unavailable: true,
  },
  {
    id: 'pinecone',
    index: '05',
    name: 'Pinecone',
    description: 'Read and write vectors from a managed index.',
    category: 'ai-vector',
    tags: ['credentials', 'ai vector', 'actions'],
    graphic: 'sphere',
    unavailable: true,
  },
  {
    id: 'airtable',
    index: '06',
    name: 'Airtable',
    description: 'Treat bases and views as tables your workflows can query.',
    category: 'files',
    tags: ['oauth', 'queryable', 'actions'],
    graphic: 'cards',
    unavailable: true,
  },
  {
    id: 'aws',
    index: '07',
    name: 'AWS',
    description: 'Reach RDS, Redshift and Athena through an IAM role.',
    category: 'warehouses',
    tags: ['oauth', 'warehouse'],
    graphic: 'cards',
    unavailable: true,
  },
  {
    id: 'notion',
    index: '08',
    name: 'Notion',
    description: 'Treat databases and pages as retrievable context.',
    category: 'files',
    tags: ['oauth', 'files'],
    graphic: 'cards',
    unavailable: true,
  },
];

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

function InstallButton({ connectorId, connectorName }: { connectorId: string; connectorName: string }) {
  const [state, formAction, pending] = useActionState(installConnectorAction.bind(null, connectorId), null);
  return (
    <form action={formAction} style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%', marginTop: 'auto' }}>
      <div style={connectionsInstallRowStyle}>
        <button
          type="submit"
          disabled={pending}
          style={{ ...connectionsInstallBtnStyle, cursor: pending ? 'not-allowed' : 'pointer' }}
          aria-label={`Install ${connectorName}`}
        >
          {'\u2192'}
        </button>
        <span style={connectionsInstallLabelStyle}>{pending ? 'Installing\u2026' : 'Install'}</span>
      </div>
      {state?.error && <span style={modalErrorStyle}>{state.error}</span>}
    </form>
  );
}

function TestButton({ connectionId }: { connectionId: string }) {
  const [state, formAction, pending] = useActionState(testConnectionAction.bind(null, connectionId), null);
  return (
    <form action={formAction} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button type="submit" disabled={pending} style={connectionsBadgeLinkStyle}>
        {pending ? 'Testing\u2026' : 'Test'}
      </button>
      {state?.error && <ActionErrorDetail error={state.error} details={state.errorDetails} />}
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
      {state?.error && <ActionErrorDetail error={state.error} details={state.errorDetails} />}
    </form>
  );
}

/**
 * Item 5 (fix-chain plan): renders the friendly `error` summary inline, plus
 * the raw `details` (original driver/connector text) behind a "Show
 * details" toggle when present and distinct from the summary — never
 * dropped, just not shown by default.
 */
function ActionErrorDetail({ error, details }: { error: string; details?: string }) {
  return (
    <span style={connectionsBadgeMetaStyle}>
      {'\u2014'} {error}
      {details && details !== error && (
        <details style={{ display: 'inline', marginLeft: 4 }}>
          <summary style={{ display: 'inline', cursor: 'pointer' }}>Show details</summary>
          <span style={{ display: 'block', marginTop: 2 }}>{details}</span>
        </details>
      )}
    </span>
  );
}

// Real backend wiring (Step 5): providers/connections come from the Step 4
// Express API (installs + connections + the static manifest catalog). Only
// MySQL has a real manifest today; the "Available" grid below still shows
// the other 7 decorative connectors as static "Coming soon" cards until
// they have manifests of their own. Write-grants (mint/revoke) are
// deliberately not surfaced here yet, per the fixed Step 5 scope.
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
  const [hoveredCard, setHoveredCard] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    | { type: 'delete'; connectionId: string; handle: string }
    | { type: 'uninstall'; installId: string; name: string }
    | null
  >(null);
  const [editingConnectionId, setEditingConnectionId] = useState<string | null>(null);

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

  const REAL_AVAILABLE: AvailableConnector[] = useMemo(() => {
    return catalog
      .filter((c) => !installs.some((i) => i.connectorId === c.id))
      .map((c) => {
        const meta = REAL_CONNECTOR_META[c.id];
        return {
          id: c.id,
          index: '',
          name: c.name,
          description: meta?.description ?? '',
          category: mapManifestCategory(c.category),
          tags: meta?.tags ?? [],
          graphic: meta?.graphic ?? 'cards',
          real: true,
        };
      });
  }, [catalog, installs]);

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

  const filteredAvailable = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...REAL_AVAILABLE, ...AVAILABLE].filter((c) => {
      if (category !== 'all' && c.category !== category) return false;
      if (q && !c.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [REAL_AVAILABLE, search, category]);

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
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search connectors \u00b7 press /"
          style={connectionsSearchBoxStyle}
        />
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
                  <ConnectorLogo id={p.id} size={18} fallback={p.initials} />
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
                  <button type="button" style={soonBtnStyle} disabled title="Coming soon">
                    Manage
                  </button>
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
          <span style={connectionsSectionMetaStyle}>{filteredAvailable.length} connectors</span>
        </div>

        {filteredAvailable.length === 0 ? (
          <div style={connectionsEmptyResultsStyle}>No connectors match this filter.</div>
        ) : (
          <div style={connectionsAvailableGridStyle}>
            {filteredAvailable.map((c) => (
              <div
                key={c.id}
                style={{
                  ...connectionsConnectorCardStyle,
                  ...(hoveredCard === c.id ? connectionsConnectorCardHoverStyle : {}),
                }}
                onMouseEnter={() => setHoveredCard(c.id)}
                onMouseLeave={() => setHoveredCard(null)}
              >
                {c.unavailable ? (
                  <>
                    <span aria-hidden="true" style={connectionsUnavailableGraphicStyle} />
                    <span style={connectionsSoonBadgeStyle}>SOON</span>
                    {c.index && <span style={connectionsConnectorIndexStyle}>{c.index}</span>}
                    <span style={connectionsUnavailableNameStyle}>{c.name}</span>
                    <span style={connectionsUnavailableDescStyle}>{c.description}</span>
                    <div style={connectionsConnectorTagsStyle}>
                      {c.tags.map((t) => (
                        <span key={t} style={connectionsConnectorTagStyle}>
                          {t}
                        </span>
                      ))}
                    </div>
                    <div style={connectionsRoadmapRowStyle}>
                      <span style={connectionsRoadmapIconStyle}>
                        <RoadmapIcon />
                      </span>
                      <span style={connectionsRoadmapLabelStyle}>On the roadmap</span>
                    </div>
                  </>
                ) : (
                  <>
                    <ConnectorGraphic type={c.graphic} />
                    {CONNECTOR_ICONS[c.id] && (
                      <span style={connectionsConnectorLogoStyle}>
                        <ConnectorLogo id={c.id} size={22} fallback={c.name.slice(0, 2)} />
                      </span>
                    )}
                    {c.index && <span style={connectionsConnectorIndexStyle}>{c.index}</span>}
                    <span style={connectionsConnectorNameStyle}>{c.name}</span>
                    <span style={connectionsConnectorDescStyle}>{c.description}</span>
                    <div style={connectionsConnectorTagsStyle}>
                      {c.tags.map((t) => (
                        <span key={t} style={connectionsConnectorTagStyle}>
                          {t}
                        </span>
                      ))}
                    </div>
                    {c.real ? (
                      <InstallButton connectorId={c.id} connectorName={c.name} />
                    ) : (
                      <div style={connectionsInstallRowStyle}>
                        <button
                          type="button"
                          style={{ ...connectionsInstallBtnStyle, cursor: 'not-allowed' }}
                          disabled
                          aria-label={`Install ${c.name}`}
                          title="Coming soon"
                        >
                          {'\u2192'}
                        </button>
                        <span style={connectionsInstallLabelStyle}>Install</span>
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        )}
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
