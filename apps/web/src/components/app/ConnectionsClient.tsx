'use client';

import { useActionState, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CONNECTOR_MANIFESTS } from '@nia/schemas';
import type { Connection, ConnectorCatalogEntry, ConnectorInstall } from '@/lib/connections/types';
import { uninstallConnectorAction, installConnectorAction } from '@/lib/connections/actions';
import { CATALOG_ORDER, CONNECTOR_CATALOG_META, resolveWorksAs } from '@/lib/connections/catalogMeta';
import type { ConnectorCategory, NxHealthStatus } from './styles';
import {
  connectionsAvailableGridStyle,
  nxConnBadgeStyle,
  nxConnCanvasHintStyle,
  nxConnCatalogHintStyle,
  nxConnCounterCellStyle,
  nxConnCounterColStyle,
  nxConnCounterLabelStyle,
  nxConnCounterRowStyle,
  nxConnCounterValueStyle,
  nxConnDangerBtnStyle,
  nxConnEmptyPanelStyle,
  nxConnEmptyResultsStyle,
  nxConnEmptyStepNumStyle,
  nxConnEmptyStepStyle,
  nxConnEmptyStepsColStyle,
  nxConnEmptySuggestColStyle,
  nxConnFilterCountStyle,
  nxConnFilterListStyle,
  nxConnFilterPillStyle,
  nxConnHeaderLeftColStyle,
  nxConnHeaderTopRowStyle,
  nxConnPageHeaderRowStyle,
  nxConnPageSubtitleStyle,
  nxConnPageTagStyle,
  nxConnPageTitleStyle,
  nxConnRequestBtnStyle,
  nxConnRowCountCellStyle,
  nxConnRowHealthCellStyle,
  nxConnRowLogoCellStyle,
  nxConnRowMenuBtnStyle,
  nxConnRowMenuItemStyle,
  nxConnRowMenuPanelStyle,
  nxConnRowMetaStyle,
  nxConnRowNameColStyle,
  nxConnRowNameStyle,
  nxConnRowStyle,
  nxConnSearchCellStyle,
  nxConnSearchHintStyle,
  nxConnSearchInputStyle,
  nxConnSectionHeaderStyle,
  nxConnSectionMetaStyle,
  nxConnSectionTitleStyle,
  nxConnSoonChipStyle,
  nxConnTitleColStyle,
  nxConnToolbarRowStyle,
  nxConnUploadBtnStyle,
  nxConnUploadIconCellStyle,
  nxConnUploadIconStyle,
  nxConnUploadMetaStyle,
  nxConnUploadNameColStyle,
  nxConnUploadNameStyle,
  nxConnUploadRowStyle,
  nxConnWorksAsListStyle,
  nxConnWorksAsPillStyle,
  nxHealthGlyphStyle,
} from './styles';
import NxConnectionsDeleteDialog from './NxConnectionsDeleteDialog';
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

// Health column (answer #4/#7): `Connection.lastTestStatus` is already a
// full page prop (no new fetch/API field) — this just aggregates it up
// to the connector-install row this page actually renders (one row per
// installed connector, not per individual connection). Worst-status-wins:
// any failing connection surfaces as 'error' even if others passed.
function aggregateHealth(connectorConnections: Connection[]): NxHealthStatus {
  if (connectorConnections.some((c) => c.lastTestStatus === 'error')) return 'error';
  if (connectorConnections.some((c) => c.lastTestStatus === 'ok')) return 'ok';
  return 'untested';
}

function HealthGlyph({ status, errorCount }: { status: NxHealthStatus; errorCount: number }) {
  const glyph = status === 'ok' ? '\u25a0' : status === 'error' ? '\u2715' : '\u2014';
  const label = status === 'ok' ? 'OK' : status === 'error' ? 'FAILED' : 'NOT TESTED';
  const title = status === 'error' ? `${errorCount} connection${errorCount === 1 ? '' : 's'} failed its last test` : undefined;
  return (
    <span style={nxHealthGlyphStyle(status)} title={title}>
      <span aria-hidden="true">{glyph}</span>
      {label}
    </span>
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
    <span style={{ fontFamily: 'var(--nx-font-mono)', fontSize: 11, color: 'var(--nx-danger-text)' }}>
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
      <ConnectorLogo id={id} tile={44} />
      <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--nx-ink)', flex: 1 }}>{name}</span>
      <form action={formAction}>
        <button type="submit" disabled={pending} style={nxConnRequestBtnStyle}>
          {pending ? 'Installing\u2026' : 'Install'}
        </button>
      </form>
      {state?.error && <ActionErrorDetail error={state.error} fix={state.errorFix} details={state.errorDetails} />}
    </div>
  );
}

/**
 * Row "\u22ef" menu, portaled to document.body — the table card's
 * overflow:hidden (removed) used to clip an in-flow absolutely-positioned
 * menu near the bottom of the list; a portal independently escapes any
 * ancestor's overflow/stacking context instead. Position is computed from
 * the trigger button's own bounding rect and flips upward when there isn't
 * room below (viewport-edge collision), matches the app's Escape-closes/
 * outside-click-closes/focus-returns-to-trigger pattern, and supports
 * arrow-key navigation between `role="menuitem"` children.
 */
function RowMenu({
  open,
  onOpenChange,
  triggerLabel = 'More actions',
  align = 'end',
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerLabel?: string;
  align?: 'start' | 'end';
  children: ReactNode;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    function computePosition() {
      const btn = btnRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const menuHeight = menuRef.current?.offsetHeight ?? 160;
      const menuWidth = menuRef.current?.offsetWidth ?? 180;
      const flipUp = rect.bottom + menuHeight > window.innerHeight;
      const top = flipUp ? rect.top - menuHeight - 4 : rect.bottom + 4;
      const left = align === 'end' ? rect.right - menuWidth : rect.left;
      setCoords({ top, left });
    }
    computePosition();
    window.addEventListener('resize', computePosition);
    window.addEventListener('scroll', computePosition, true);
    return () => {
      window.removeEventListener('resize', computePosition);
      window.removeEventListener('scroll', computePosition, true);
    };
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      onOpenChange(false);
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onOpenChange(false);
        btnRef.current?.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
        if (!items || items.length === 0) return;
        const currentIndex = Array.from(items).findIndex((el) => el === document.activeElement);
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        const nextIndex = (currentIndex + delta + items.length) % items.length;
        items[nextIndex]?.focus();
      }
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onOpenChange]);

  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerLabel}
        style={nxConnRowMenuBtnStyle}
        onClick={() => onOpenChange(!open)}
      >
        {'\u22ef'}
      </button>
      {open && coords && typeof document !== 'undefined'
        ? createPortal(
            <div ref={menuRef} role="menu" style={{ ...nxConnRowMenuPanelStyle, position: 'fixed', top: coords.top, left: coords.left }}>
              {children}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export default function ConnectionsClient({
  currentUserId: _currentUserId,
  catalog,
  installs,
  connections,
}: {
  currentUserId: string;
  catalog: ConnectorCatalogEntry[];
  installs: ConnectorInstall[];
  connections: Connection[];
}) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<ConnectorCategory | 'all'>('all');
  const [worksAs, setWorksAs] = useState<'any' | 'source' | 'destination'>('any');
  const [openMenuRowId, setOpenMenuRowId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ type: 'uninstall'; installId: string; name: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Install flow: a real connector card installs directly (no credentials
  // form on this page — adding a connection is canvas-only, per the
  // intended product model). Once installConnectorAction succeeds and the
  // revalidated `installs` prop includes the connector, scroll to its row
  // in the Installed section and briefly highlight it.
  const installedRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [pendingScrollId, setPendingScrollId] = useState<string | null>(null);
  const [highlightedProviderId, setHighlightedProviderId] = useState<string | null>(null);

  // Condition #5: "/" focuses search, everywhere except while the user is
  // already typing into a field (an input/textarea/contenteditable).
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

  const installedIds = useMemo(() => new Set(installs.map((i) => i.connectorId)), [installs]);

  // Catalog grid is driven entirely by catalogMeta.ts's static 12-connector
  // list — its `comingSoon` flag is the single source of truth for which
  // cards render "Install"/"SOON"/roadmap (only the 4 ids with real
  // manifests in registry.ts are `comingSoon: false`).
  const catalogEntries = useMemo(() => CATALOG_ORDER.map((id) => CONNECTOR_CATALOG_META[id]!), []);
  const realCatalogEntries = useMemo(() => catalogEntries.filter((c) => !c.comingSoon), [catalogEntries]);

  // Real `/connectors` API entries (operations/capabilities), keyed by id
  // — passed into ConnectorCard so the 4 real connectors' Source/
  // Destination facts and "Works as" filtering read genuine API data
  // instead of catalogMeta's static fallback (see resolveWorksAs).
  const catalogByIdMap = useMemo(() => new Map(catalog.map((c) => [c.id, c])), [catalog]);
  const connectionsByConnector = useMemo(() => {
    const map = new Map<string, Connection[]>();
    for (const c of connections) {
      const list = map.get(c.connectorId);
      if (list) list.push(c);
      else map.set(c.connectorId, [c]);
    }
    return map;
  }, [connections]);
  const connectionCountByConnector = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of connections) map.set(c.connectorId, (map.get(c.connectorId) ?? 0) + 1);
    return map;
  }, [connections]);
  const categoryCounts = useMemo(() => {
    const map = new Map<ConnectorCategory, number>();
    for (const c of catalogEntries) map.set(c.category, (map.get(c.category) ?? 0) + 1);
    return map;
  }, [catalogEntries]);

  // Once installConnectorAction succeeds (ConnectorCard's onInstalled) and
  // the server-revalidated `installs` prop actually includes the connector,
  // scroll its Installed-section row into view and briefly highlight it.
  useEffect(() => {
    if (!pendingScrollId || !installedIds.has(pendingScrollId)) return;
    const id = pendingScrollId;
    setPendingScrollId(null);
    installedRowRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedProviderId(id);
    const timer = setTimeout(() => setHighlightedProviderId((current) => (current === id ? null : current)), 1800);
    return () => clearTimeout(timer);
  }, [installedIds, pendingScrollId]);

  const filteredCatalog = useMemo(() => {
    const q = search.trim().toLowerCase();
    return catalogEntries.filter((c) => {
      if (category !== 'all' && c.category !== category) return false;
      if (q && !c.name.toLowerCase().includes(q)) return false;
      if (worksAs !== 'any') {
        const { isSource, isDestination } = resolveWorksAs(c, catalogByIdMap.get(c.id));
        if (worksAs === 'source' && !isSource) return false;
        if (worksAs === 'destination' && !isDestination) return false;
      }
      return true;
    });
  }, [catalogEntries, search, category, worksAs, catalogByIdMap]);

  // No connectors installed at all yet — show the getting-started panel
  // instead of an empty table (see "Connections — no connections yet").
  const showEmptyState = installs.length === 0;

  function handleUninstall(connectorId: string) {
    const install = installs.find((i) => i.connectorId === connectorId);
    if (!install) return;
    const meta = CONNECTOR_CATALOG_META[connectorId];
    setDialog({ type: 'uninstall', installId: install.id, name: meta?.name ?? connectorId });
  }

  return (
    <>
      <div style={nxConnPageHeaderRowStyle}>
        <div style={nxConnHeaderLeftColStyle}>
          <div style={nxConnHeaderTopRowStyle}>
            <span style={nxConnPageTagStyle}>Platform / Connections</span>
            {/* No request-a-connector endpoint exists yet — inert like the
                Upload CSV button below, not wired to an invented action. */}
            <button type="button" style={nxConnRequestBtnStyle} disabled title="Coming soon">
              Request a connector
              <span style={nxConnSoonChipStyle}>Soon</span>
            </button>
          </div>
          <div style={nxConnTitleColStyle}>
            <h1 style={nxConnPageTitleStyle}>Connections</h1>
            <span style={nxConnPageSubtitleStyle}>The databases, warehouses and tools your workflows read from and write to.</span>
          </div>
        </div>
        <div style={nxConnCounterColStyle}>
          <div style={nxConnCounterRowStyle}>
            <div style={nxConnCounterCellStyle(false)}>
              <span style={nxConnCounterLabelStyle}>Installed</span>
              <span style={nxConnCounterValueStyle}>{String(installs.length).padStart(2, '0')}</span>
            </div>
            <div style={nxConnCounterCellStyle(true)}>
              <span style={nxConnCounterLabelStyle}>Connections</span>
              <span style={nxConnCounterValueStyle}>{String(connections.length).padStart(2, '0')}</span>
            </div>
          </div>
          <span style={nxConnCanvasHintStyle}>ADD CONNECTIONS FROM A WORKFLOW CANVAS {'\u2192'}</span>
        </div>
      </div>

      {showEmptyState ? (
        <div style={nxConnEmptyPanelStyle}>
          <div style={nxConnEmptyStepsColStyle}>
            <span style={nxConnSectionTitleStyle}>Get started</span>
            <div style={nxConnEmptyStepStyle}>
              <span style={nxConnEmptyStepNumStyle}>1</span>
              <span style={nxConnSectionMetaStyle}>Install a connector below.</span>
            </div>
            <div style={nxConnEmptyStepStyle}>
              <span style={nxConnEmptyStepNumStyle}>2</span>
              <span style={nxConnSectionMetaStyle}>Open a workflow canvas.</span>
            </div>
            <div style={nxConnEmptyStepStyle}>
              <span style={nxConnEmptyStepNumStyle}>3</span>
              <span style={nxConnSectionMetaStyle}>Add a connection from a connector node — adding a connection always happens on the canvas.</span>
            </div>
          </div>
          <div style={nxConnEmptySuggestColStyle}>
            <span style={nxConnSectionTitleStyle}>Suggested connectors</span>
            {realCatalogEntries.map((meta) => (
              <SuggestedConnectorRow key={meta.id} id={meta.id} name={meta.name} onInstalled={setPendingScrollId} />
            ))}
          </div>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={nxConnSectionHeaderStyle}>
              <span style={nxConnSectionTitleStyle}>Installed</span>
              <span style={nxConnSectionMetaStyle}>
                {installs.length} connector{installs.length === 1 ? '' : 's'}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {installs.map((install) => {
                const meta = CONNECTOR_CATALOG_META[install.connectorId];
                const manifest = CONNECTOR_MANIFESTS[install.connectorId];
                const count = connectionCountByConnector.get(install.connectorId) ?? 0;
                const highlighted = highlightedProviderId === install.connectorId;
                const connectorConnections = connectionsByConnector.get(install.connectorId) ?? [];
                const health = aggregateHealth(connectorConnections);
                const errorCount = connectorConnections.filter((c) => c.lastTestStatus === 'error').length;
                return (
                  <div
                    key={install.id}
                    data-testid={`provider-row-${install.connectorId}`}
                    ref={(el) => {
                      installedRowRefs.current[install.connectorId] = el;
                    }}
                    style={{
                      ...nxConnRowStyle,
                      transition: 'background 1.2s ease',
                      background: highlighted ? 'color-mix(in srgb, var(--nx-blue-panel) 12%, var(--nx-bg))' : undefined,
                    }}
                  >
                    <div style={nxConnRowLogoCellStyle}>
                      <ConnectorLogo id={install.connectorId} tile={40} />
                    </div>
                    <span style={nxConnRowNameColStyle}>
                      <span style={nxConnRowNameStyle}>{meta?.name ?? install.connectorId}</span>
                      <span style={nxConnRowMetaStyle}>
                        {meta ? CATEGORY_LABEL[meta.category] : ''}
                        {manifest?.version && (
                          <>
                            {' \u00b7 '}
                            <span>v{manifest.version}</span>
                          </>
                        )}
                        {meta?.authMethod && (
                          <>
                            {' \u00b7 '}
                            <span>{meta.authMethod}</span>
                          </>
                        )}
                      </span>
                    </span>
                    <div style={nxConnRowCountCellStyle}>
                      <span style={nxConnBadgeStyle(count > 0)}>
                        {count > 0 ? `${count} connection${count === 1 ? '' : 's'}` : 'No connections yet'}
                      </span>
                    </div>
                    <div style={nxConnRowHealthCellStyle}>
                      <HealthGlyph status={health} errorCount={errorCount} />
                    </div>
                    <button
                      type="button"
                      style={nxConnDangerBtnStyle}
                      onClick={() => setDialog({ type: 'uninstall', installId: install.id, name: meta?.name ?? install.connectorId })}
                    >
                      Uninstall
                    </button>
                    {meta?.docsUrl ? (
                      <RowMenu open={openMenuRowId === install.id} onOpenChange={(o) => setOpenMenuRowId(o ? install.id : null)}>
                        <a
                          href={meta.docsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          role="menuitem"
                          tabIndex={-1}
                          style={nxConnRowMenuItemStyle}
                        >
                          View docs
                        </a>
                      </RowMenu>
                    ) : (
                      <div style={{ borderLeft: '1px solid var(--nx-line-inner)' }} />
                    )}
                  </div>
                );
              })}
              <div style={nxConnUploadRowStyle}>
                <div style={nxConnUploadIconCellStyle}>
                  <span style={nxConnUploadIconStyle} aria-hidden="true">
                    {'\u2913'}
                  </span>
                </div>
                <span style={nxConnUploadNameColStyle}>
                  <span style={nxConnUploadNameStyle}>Upload a CSV or Excel file</span>
                  <span style={nxConnUploadMetaStyle}>Treat a spreadsheet as a workflow source — no connector required.</span>
                </span>
                <button type="button" disabled title="Coming soon" style={nxConnUploadBtnStyle}>
                  Choose file
                  <span style={nxConnSoonChipStyle}>Soon</span>
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      <div className="nia-connector-catalog" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={nxConnSectionHeaderStyle}>
          <span style={nxConnSectionTitleStyle}>Add a connection</span>
          <span style={nxConnSectionMetaStyle}>{filteredCatalog.length} connectors</span>
        </div>

        <div style={nxConnToolbarRowStyle}>
          <label style={nxConnSearchCellStyle}>
            <span aria-hidden="true">{'\u2315'}</span>
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search connectors"
              style={nxConnSearchInputStyle}
            />
            {!search && (
              <span aria-hidden="true" style={nxConnSearchHintStyle}>
                /
              </span>
            )}
          </label>
          <div style={nxConnFilterListStyle} role="tablist">
            <button type="button" role="tab" aria-selected={category === 'all'} style={nxConnFilterPillStyle(category === 'all')} onClick={() => setCategory('all')}>
              All <span style={nxConnFilterCountStyle(category === 'all')}>{catalogEntries.length}</span>
            </button>
            {CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                role="tab"
                aria-selected={category === c}
                style={nxConnFilterPillStyle(category === c)}
                onClick={() => setCategory(c)}
              >
                {CATEGORY_LABEL[c]} <span style={nxConnFilterCountStyle(category === c)}>{categoryCounts.get(c) ?? 0}</span>
              </button>
            ))}
          </div>
          <div style={nxConnWorksAsListStyle} role="tablist" aria-label="Works as">
            <button type="button" role="tab" aria-selected={worksAs === 'any'} style={nxConnWorksAsPillStyle(worksAs === 'any')} onClick={() => setWorksAs('any')}>
              Any
            </button>
            <button type="button" role="tab" aria-selected={worksAs === 'source'} style={nxConnWorksAsPillStyle(worksAs === 'source')} onClick={() => setWorksAs('source')}>
              Source
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={worksAs === 'destination'}
              style={nxConnWorksAsPillStyle(worksAs === 'destination')}
              onClick={() => setWorksAs('destination')}
            >
              Destination
            </button>
          </div>
        </div>

        {filteredCatalog.length === 0 ? (
          <div style={nxConnEmptyResultsStyle}>No connectors match this filter.</div>
        ) : (
          <div style={connectionsAvailableGridStyle} className="nia-connector-grid" data-testid="connector-grid">
            {filteredCatalog.map((meta) => (
              <ConnectorCard
                key={meta.id}
                meta={meta}
                installed={installedIds.has(meta.id)}
                connectionCount={connectionCountByConnector.get(meta.id) ?? 0}
                onInstalled={setPendingScrollId}
                onUninstall={handleUninstall}
              />
            ))}
          </div>
        )}

        {/* Column count follows the source's 4-up layout at full width
            (1440px), against this section's own content width (container
            query, not viewport), stepping down at narrower widths: 4 >=
            1200px, 3 from 860-1199px, 2 from 540-859px, 1 below 540px — see
            connectionsAvailableGridStyle. */}
        <style>{`
          .nia-connector-catalog { container-type: inline-size; }
          .nia-connector-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
          @container (max-width: 1199px) {
            .nia-connector-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
          }
          @container (max-width: 859px) {
            .nia-connector-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          }
          @container (max-width: 539px) {
            .nia-connector-grid { grid-template-columns: repeat(1, minmax(0, 1fr)); }
          }
        `}</style>

        <span style={nxConnCatalogHintStyle}>
          Missing something?{' '}
          <button
            type="button"
            disabled
            title="Coming soon"
            style={{ fontFamily: 'inherit', fontSize: 'inherit', color: 'var(--nx-ink)', textDecoration: 'underline', background: 'none', border: 'none', padding: 0, cursor: 'not-allowed' }}
          >
            Request a connector
          </button>
        </span>
      </div>

      {dialog?.type === 'uninstall' && (
        <NxConnectionsDeleteDialog
          title="Uninstall connector?"
          message={`This removes ${dialog.name} from your workspace. You'll need to delete its connections first if it has any.`}
          hiddenFields={{ id: dialog.installId }}
          action={uninstallConnectorAction}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}
