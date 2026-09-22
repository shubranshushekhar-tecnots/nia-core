'use client';

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CONNECTOR_MANIFESTS, WRITE_OPERATIONS, buildGrantStatementText, parseNodeConfig, transformOutputFields, type CheckResult, type EntityRef, type Operation, type SourceDestConfig, type TransformConfig } from '@nia/schemas';
import type { CanvasNode } from '@/lib/canvas/mapping';
import { confirmWriteGrant, createWriteGrant, getConnectionSchema, getWriteGrants, revokeWriteGrant, type WriteGrant } from '@/lib/api/connectionsClient';
import TransformEditor from './TransformEditor';
import MappingEditor from './MappingEditor';
import ProfileTab from './ProfileTab';
import { KIND_COLOR, KIND_LABEL } from './GraphFlowNode';
import { getConnectorIcon } from './icons';
import {
  configPanelDeleteBtnStyle,
  configPanelDetailHintStyle,
  configPanelDetailStyle,
  configPanelDividerStyle,
  configPanelGroupLabelStyle,
  configPanelGroupStyle,
  configPanelIconBtnStyle,
  configPanelIdentityIconStyle,
  configPanelRibbonStyle,
  configPanelSelectStyle,
  panelTabBarStyle,
  panelTabStyle,
  segmentedControlStyle,
  segmentedOptionStyle,
} from './styles';

/**
 * Node properties panel content — rendered inside NodeConfigPanel.tsx's
 * docked top band (a fixed-height ribbon row + a reserved scrollable
 * detail row beneath it), not as its own floating panel. Branches on the
 * node's resolution/type:
 *   - unresolved ("unknown tool")  -> read-only, delete-only
 *   - source / destination         -> verb selector, write verbs locked
 *   - transform                    -> TransformEditor (filter/computed/drop)
 *
 * Layout-only restructure (ribbon+detail groups instead of a vertically
 * stacked form) — every hook, onChange call, and computed value below is
 * unchanged from the pre-restructure version; only the returned JSX
 * arrangement differs. Kept this way deliberately: the entity/table
 * picker below has a confirmed, unreproduced reload-persistence bug, and
 * touching its state plumbing in the same pass as a layout change would
 * make that bug unreproducible in isolation.
 */

/** `entity` refs have no natural single-string key (namespace+name can each contain anything) — NUL is never a valid identifier character in any of this codebase's supported dialects, so it's a safe join separator for a <select> option value. */
const ENTITY_KEY_SEP = '\u0000';
function entityKey(ref: EntityRef): string {
  return `${ref.namespace}${ENTITY_KEY_SEP}${ref.name}`;
}
function parseEntityKey(key: string): EntityRef {
  const [namespace, name] = key.split(ENTITY_KEY_SEP);
  return { namespace: namespace ?? '', name: name ?? '' };
}

/**
 * Phase 6 Block 0 — mirrors MappingEditor.tsx's useEntityFields, same query
 * key (`['connection-schema', connectionId]`) so both hooks share one
 * react-query cache entry per connection rather than double-fetching.
 * Returns entities (not a flat field union) since this hook backs the
 * table/entity picker, not a field dropdown. Block 2 extends this hook's
 * caller to destination nodes too — a destination now also needs an entity
 * selected so checkGrants/the lock logic below have a namespace to check
 * write-grant coverage against.
 */
function useConnectionEntities(connectionId?: string): { namespace: string; name: string }[] {
  const { data: schema } = useQuery({
    queryKey: ['connection-schema', connectionId],
    queryFn: () => getConnectionSchema(connectionId!),
    enabled: !!connectionId,
    staleTime: 5 * 60_000,
  });
  return useMemo(() => {
    if (!schema) return [];
    return schema.entities
      .map((e) => ({ namespace: e.namespace, name: e.name }))
      .sort((a, b) => (a.namespace + a.name).localeCompare(b.namespace + b.name));
  }, [schema]);
}

/**
 * Phase 6 Block 2 — the set of schema namespaces this connection has an
 * active (confirmed, unrevoked) write grant covering. Mirrors the server's
 * own check (checkGrants in @nia/schemas/checks.ts, resolveWriteGrant.ts on
 * the worker side, verifyActiveWriteGrant in connector-supabase's
 * pool-manager.ts) purely for UX — this is layer 1 of the spec's
 * three-layer guardrail (UI unlock / API validation / the write
 * credential's actual DB privileges), never the enforcement itself. A
 * grant with a scope that isn't `{ schemas: [...] }`-shaped, or with no
 * schemas array at all, covers nothing.
 */
function useWriteGrants(connectionId?: string): WriteGrant[] {
  const { data: grants } = useQuery({
    queryKey: ['connection-write-grants', connectionId],
    queryFn: () => getWriteGrants(connectionId!),
    enabled: !!connectionId,
    staleTime: 30_000,
  });
  return grants ?? [];
}

function grantScopeHasNamespace(grant: WriteGrant, namespace: string): boolean {
  const schemas = (grant.scope as { schemas?: unknown } | null)?.schemas;
  return Array.isArray(schemas) && schemas.some((s) => s === namespace);
}

function useGrantedNamespaces(grants: WriteGrant[]): Set<string> {
  return useMemo(() => {
    const namespaces = new Set<string>();
    for (const grant of grants) {
      if (!grant.confirmedAt || grant.revokedAt) continue;
      const schemas = (grant.scope as { schemas?: unknown } | null)?.schemas;
      if (Array.isArray(schemas)) {
        for (const s of schemas) if (typeof s === 'string') namespaces.add(s);
      }
    }
    return namespaces;
  }, [grants]);
}

const grantPanelStyle = {
  marginTop: 10,
  padding: 10,
  border: '1px solid var(--line2)',
  borderRadius: 8,
  background: 'var(--surface2)',
} as const;

const grantButtonStyle = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--ink)',
  background: 'var(--surface)',
  border: '1px solid var(--line2)',
  borderRadius: 6,
  padding: '5px 10px',
  cursor: 'pointer',
} as const;

/** Random, identifier-safe: `nia_write_` + 8 lowercase-hex chars from crypto.randomUUID(). */
function randomWriteRoleUser(): string {
  return `nia_write_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

function randomWriteRolePassword(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/**
 * Phase 6 Block 5 — the grant-creation UI Block 2 never shipped (see
 * PHASE6_SESSION_NOTES.md's Block 4 correction / docs/decisions.md). Two
 * steps, matching 0016_write_grants.sql's model exactly:
 *   1. Generate a role user/password, mint a grant scoped to `namespace`
 *      (createWriteGrant), and show copy-ready CREATE ROLE/GRANT statement
 *      text for the user to run against their own database.
 *   2. Once they've run it, "Confirm access" sends that same credential to
 *      confirmWriteGrant, which stores it in Vault server-side and attaches
 *      the ref — unlocking the write verbs above.
 * A grant already created-but-not-confirmed for this namespace (e.g. the
 * user navigated away mid-flow) resumes at step 2 instead of minting a
 * second grant, using the same generated statement text so the credential
 * shown still matches what confirm will send (nothing is persisted client-
 * side beyond this component's state — re-mounting loses it, which is
 * acceptable for a one-time setup flow, not a recurring one).
 */
function GrantAccessPanel({
  connectionId,
  connectorId,
  namespace,
  pendingGrant,
}: {
  connectionId: string;
  connectorId?: string;
  namespace: string;
  pendingGrant?: WriteGrant;
}) {
  const queryClient = useQueryClient();
  const [credential] = useState(() => ({ user: randomWriteRoleUser(), password: randomWriteRolePassword() }));
  const [grant, setGrant] = useState<WriteGrant | undefined>(pendingGrant);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const statementText = connectorId ? buildGrantStatementText(connectorId, namespace, credential.user, credential.password) : null;

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      const created = await createWriteGrant(connectionId, { schemas: [namespace] });
      setGrant(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create write grant.');
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm() {
    if (!grant) return;
    setBusy(true);
    setError(null);
    try {
      await confirmWriteGrant(connectionId, grant.id, credential);
      await queryClient.invalidateQueries({ queryKey: ['connection-write-grants', connectionId] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to confirm write grant.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy() {
    if (!statementText) return;
    await navigator.clipboard.writeText(statementText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div style={grantPanelStyle}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', marginBottom: 6 }}>Grant write access to &quot;{namespace}&quot;</div>
      {!grant ? (
        <>
          <div style={{ fontSize: 11.5, color: 'var(--ink4)', marginBottom: 8 }}>
            Mints a role/password for this schema and shows a statement to run against your database.
          </div>
          <button type="button" style={grantButtonStyle} disabled={busy} onClick={handleCreate}>
            {busy ? 'Creating…' : 'Grant write access'}
          </button>
        </>
      ) : !grant.confirmedAt ? (
        <>
          <div style={{ fontSize: 11.5, color: 'var(--ink4)', marginBottom: 6 }}>
            Run this against the connection&apos;s database, then confirm below.
          </div>
          {statementText ? (
            <>
              <pre
                style={{
                  fontFamily: 'var(--font-data)',
                  fontSize: 11,
                  background: 'var(--surface)',
                  border: '1px solid var(--line2)',
                  borderRadius: 6,
                  padding: 8,
                  whiteSpace: 'pre-wrap',
                  overflowX: 'auto',
                  marginBottom: 8,
                }}
              >
                {statementText}
              </pre>
              <button type="button" style={{ ...grantButtonStyle, marginRight: 8 }} onClick={handleCopy}>
                {copied ? 'Copied' : 'Copy statement'}
              </button>
            </>
          ) : (
            <div style={{ fontSize: 11.5, color: 'var(--warn)', marginBottom: 8 }}>No statement text for this connector yet — ask your database admin.</div>
          )}
          <button type="button" style={grantButtonStyle} disabled={busy} onClick={handleConfirm}>
            {busy ? 'Confirming…' : "I've run this — confirm access"}
          </button>
        </>
      ) : (
        <div style={{ fontSize: 11.5, color: 'var(--ok)' }}>Confirmed.</div>
      )}
      {error && <div style={{ fontSize: 11.5, color: 'var(--bad)', marginTop: 6 }}>{error}</div>}
    </div>
  );
}

/**
 * Phase 6 Block 5 (Part 3e) — the counterpart to GrantAccessPanel: once a
 * namespace is grant-covered, offer to revoke it from the same spot instead
 * of leaving `revokeWriteGrant` (connectionsClient.ts) wired but unused.
 * Revoking doesn't touch the underlying DB role/privileges (that's a manual
 * `REVOKE`/`DROP ROLE` step, same asymmetry as granting requiring a manual
 * `CREATE ROLE`/`GRANT`) — it only flips the row so `checkGrants`/the verb
 * lock immediately treat this namespace as uncovered again.
 */
function RevokeAccessPanel({ connectionId, grant, namespace }: { connectionId: string; grant: WriteGrant; namespace: string }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRevoke() {
    setBusy(true);
    setError(null);
    try {
      await revokeWriteGrant(connectionId, grant.id);
      await queryClient.invalidateQueries({ queryKey: ['connection-write-grants', connectionId] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke write grant.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={grantPanelStyle}>
      <div style={{ fontSize: 11.5, color: 'var(--ok)', marginBottom: 8 }}>
        Write access granted to &quot;{namespace}&quot;.
      </div>
      <button type="button" style={grantButtonStyle} disabled={busy} onClick={handleRevoke}>
        {busy ? 'Revoking…' : 'Revoke access'}
      </button>
      {error && <div style={{ fontSize: 11.5, color: 'var(--bad)', marginTop: 6 }}>{error}</div>}
    </div>
  );
}

/**
 * Mounted twice by NodeDrawer below — once per `slot` — rather than being
 * restructured to accept a single combined render. Both instances call the
 * exact same hooks (useConnectionEntities/useWriteGrants/useGrantedNamespaces)
 * unconditionally, so React's rules-of-hooks stay satisfied per-instance;
 * react-query dedupes the underlying fetches since both instances share the
 * same query keys (`['connection-schema', connectionId]` /
 * `['connection-write-grants', connectionId]`). This is a presentation-only
 * duplication — every computed value and onChange call below is byte-for-
 * byte identical to the pre-restructure single-render version.
 */
function SourceDestForm({
  slot,
  config,
  operations,
  nodeType,
  connectionId,
  manifestId,
  onChange,
}: {
  slot: 'ribbon' | 'detail';
  config: SourceDestConfig;
  operations: Operation[];
  nodeType: 'source' | 'destination';
  connectionId?: string;
  manifestId?: string;
  onChange: (next: SourceDestConfig) => void;
}) {
  const entities = useConnectionEntities(connectionId);
  const grants = useWriteGrants(connectionId);
  const grantedNamespaces = useGrantedNamespaces(grants);
  /** Schema layer Part 4's "type a new name" toggle — see NewTargetInputs's doc comment. Declared unconditionally (before the slot==='detail' early return below) since this component renders twice (ribbon + detail slots) and hooks must stay in the same order every render. */
  const [newTargetMode, setNewTargetMode] = useState(false);
  const selectedKey = config.entity ? entityKey(config.entity) : '';
  const namespace = config.entity?.namespace;
  const grantCovers = namespace !== undefined && grantedNamespaces.has(namespace);
  const pendingGrant =
    namespace !== undefined
      ? grants.find((g) => !g.revokedAt && !g.confirmedAt && grantScopeHasNamespace(g, namespace))
      : undefined;
  const activeGrant =
    namespace !== undefined
      ? grants.find((g) => !g.revokedAt && g.confirmedAt && grantScopeHasNamespace(g, namespace))
      : undefined;

  if (slot === 'detail') {
    if (nodeType !== 'destination' || !connectionId || namespace === undefined) return null;
    if (!grantCovers) {
      return <GrantAccessPanel connectionId={connectionId} connectorId={manifestId} namespace={namespace} pendingGrant={pendingGrant} />;
    }
    if (activeGrant) {
      return <RevokeAccessPanel connectionId={connectionId} grant={activeGrant} namespace={namespace} />;
    }
    return null;
  }

  return (
    <>
      <div style={configPanelGroupStyle}>
        <span style={configPanelGroupLabelStyle}>Verb</span>
        <div role="radiogroup" aria-label="Verb" style={segmentedControlStyle}>
          {operations.map((op) => {
            // Phase 6 Block 2: a write verb unlocks once the node's connection
            // has a confirmed, unrevoked write grant covering the selected
            // entity's namespace — mirrors checkGrants' server-side pass
            // condition exactly (@nia/schemas/checks.ts). This is layer 1 of
            // the three-layer guardrail; the connector service and its actual
            // DB privileges (layers 2/3) still enforce this independently.
            const isWriteOp = WRITE_OPERATIONS.includes(op);
            const locked = isWriteOp && !grantCovers;
            const lockedReason = !namespace
              ? 'Select a table with an active write grant to unlock this verb.'
              : `Requires a confirmed write grant covering "${namespace}".`;
            const active = config.operation === op;
            return (
              <label
                key={op}
                title={locked ? lockedReason : undefined}
                style={{ ...segmentedOptionStyle(active, locked), position: 'relative' }}
              >
                <input
                  type="radio"
                  name="operation"
                  disabled={locked}
                  checked={active}
                  onChange={() => onChange({ ...config, operation: op })}
                  style={{ position: 'absolute', inset: 0, opacity: 0, margin: 0, cursor: locked ? 'not-allowed' : 'pointer' }}
                />
                {op}
              </label>
            );
          })}
        </div>
      </div>

      <div style={configPanelDividerStyle} />

      <div style={configPanelGroupStyle}>
        <span style={configPanelGroupLabelStyle}>Table</span>
        {entities.length === 0 ? (
          <span style={{ fontSize: 12, color: 'var(--ink4)', whiteSpace: 'nowrap' }}>
            {connectionId ? 'Loading tables…' : 'Select a connection first.'}
          </span>
        ) : newTargetMode ? (
          <NewTargetInputs entity={config.entity} onChange={(entity) => onChange({ ...config, entity })} onCancel={() => setNewTargetMode(false)} />
        ) : (
          <select
            value={selectedKey}
            onChange={(e) => {
              if (e.target.value === NEW_TARGET_SENTINEL) {
                setNewTargetMode(true);
                return;
              }
              onChange({ ...config, entity: e.target.value ? parseEntityKey(e.target.value) : undefined });
            }}
            style={configPanelSelectStyle}
          >
            <option value="">{nodeType === 'source' ? 'Infer from mapping…' : 'Select a table…'}</option>
            {entities.map((e) => (
              <option key={entityKey(e)} value={entityKey(e)}>
                {e.namespace ? `${e.namespace}.${e.name}` : e.name}
              </option>
            ))}
            {/* Schema layer Part 4: "choose an existing target or type a new name" — destination only, since ensureDestination.ts (apps/worker) auto-creates a missing destination target from the contract, but a source still requires a pre-existing table to read from. */}
            {nodeType === 'destination' && <option value={NEW_TARGET_SENTINEL}>+ Create new…</option>}
          </select>
        )}
      </div>
    </>
  );
}

/** Sentinel `<option>` value distinguishing "create new" from parseEntityKey's real namespace/name strings — NUL (ENTITY_KEY_SEP) can never appear in a typed option value, so this can never collide with a real entity key. */
const NEW_TARGET_SENTINEL = '__new__';

/**
 * Schema layer Part 4's "type a new name" half of the target picker.
 * Deliberately two plain text inputs writing straight through to
 * `config.entity` via the same `onChange` prop every other control in this
 * form already uses — no new state mechanism, so this can't interact with
 * the pre-existing entity-picker reload-persistence bug noted in this
 * component's header comment (that bug lives in the `<select>`/entities
 * list path, untouched here).
 */
function NewTargetInputs({
  entity,
  onChange,
  onCancel,
}: {
  entity: EntityRef | undefined;
  onChange: (entity: EntityRef) => void;
  onCancel: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input
        value={entity?.namespace ?? ''}
        onChange={(e) => onChange({ namespace: e.target.value, name: entity?.name ?? '' })}
        placeholder="namespace"
        style={{ ...configPanelSelectStyle, width: 90, fontFamily: 'var(--font-data)' }}
      />
      <span style={{ color: 'var(--ink4)', fontSize: 12 }}>.</span>
      <input
        value={entity?.name ?? ''}
        onChange={(e) => onChange({ namespace: entity?.namespace ?? '', name: e.target.value })}
        placeholder="new table name"
        style={{ ...configPanelSelectStyle, flex: 1, fontFamily: 'var(--font-data)' }}
      />
      <button
        type="button"
        aria-label="Back to existing tables"
        onClick={onCancel}
        style={{ border: 'none', background: 'none', color: 'var(--ink4)', cursor: 'pointer', fontSize: 12, padding: 0 }}
      >
        {'\u2715'}
      </button>
    </div>
  );
}

export default function NodeDrawer({
  node,
  workflowId,
  upstreamSource,
  checkResults,
  onConfigChange,
  onDelete,
  onClose,
}: {
  node: CanvasNode;
  workflowId: string;
  upstreamSource?: { connectionId?: string; manifestId?: string; entity?: EntityRef; transformConfigs?: Record<string, unknown>[] };
  /** Latest persisted check-run results, forwarded to MappingEditor to gate Preview. See MappingEditor.tsx's prop comment. */
  checkResults?: CheckResult[] | null;
  onConfigChange: (config: Record<string, unknown>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { data } = node;
  const manifest = data.manifestId ? CONNECTOR_MANIFESTS[data.manifestId] : undefined;
  const parsed = parseNodeConfig(data.graphNodeType, data.config);
  const identityColor = data.resolved ? KIND_COLOR[data.graphNodeType] : 'var(--warn)';
  const IdentityIcon = getConnectorIcon(data.manifestId, data.graphNodeType);
  const identityName = data.resolved ? (data.manifestName ?? 'Unconfigured') : (data.unknownReason ?? 'Unknown');
  const identityTitle = `${identityName}${data.connectionLabel ? ` · ${data.connectionLabel}` : ''}`;
  const showSourceDestForm = data.resolved && data.graphNodeType !== 'transform' && !parsed.unrecognized;
  const sourceDestConfig = !parsed.unrecognized ? (parsed.value as SourceDestConfig) : undefined;
  const showMappingTab = data.graphNodeType === 'destination' && showSourceDestForm;
  // Profile tab needs an entity selected — with none picked yet there's nothing to profile (mirrors the mapping tab's own showSourceDestForm gate).
  const showProfileTab = data.graphNodeType === 'source' && showSourceDestForm && !!sourceDestConfig?.entity && !!data.connectionId;
  const showTabs = showMappingTab || showProfileTab;
  const [activeTab, setActiveTab] = useState<'setup' | 'mapping' | 'profile'>('setup');

  // Only override the mapping dropdown's source-field list when exactly one
  // transform node sits on the path — 0 transforms means nothing to
  // override (raw fields are already correct), 2+ degrades to "unknown"
  // rather than guessing, same conservative convention runPreview.ts's
  // pushdown chaining uses (transforms.length === 1). transformOutputFields
  // itself returns null when that one transform has no aggregate step, so
  // the override only ever kicks in for an actual Aggregate transform.
  const upstreamTransformConfigs = upstreamSource?.transformConfigs ?? [];
  const sourceFieldsOverride =
    upstreamTransformConfigs.length === 1
      ? (() => {
          const parsedTransform = parseNodeConfig('transform', upstreamTransformConfigs[0]!);
          const transformConfig = !parsedTransform.unrecognized && parsedTransform.type === 'transform' ? parsedTransform.value : undefined;
          return transformConfig ? (transformOutputFields(transformConfig) ?? undefined) : undefined;
        })()
      : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }} data-testid="node-drawer">
      {/* Header: icon tile + type + title + connection name + delete/close — no inline form controls here anymore, those moved into the Setup tab body below. */}
      <div style={configPanelRibbonStyle}>
        <div style={configPanelGroupStyle}>
          <span style={configPanelGroupLabelStyle}>{KIND_LABEL[data.graphNodeType]}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }} title={identityTitle}>
            <span style={configPanelIdentityIconStyle(identityColor)} aria-hidden>
              <IdentityIcon size={13} />
            </span>
            <span
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: data.resolved ? 'var(--ink)' : 'var(--warn)',
                maxWidth: 140,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {identityName}
            </span>
            {data.connectionLabel && (
              <span
                style={{
                  fontSize: 11,
                  color: 'var(--ink4)',
                  maxWidth: 100,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 'none',
                }}
              >
                · {data.connectionLabel}
              </span>
            )}
          </div>
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
          <button type="button" aria-label="Delete node" onClick={onDelete} style={configPanelDeleteBtnStyle}>
            {'\u{1F5D1}'}
          </button>
          <button type="button" aria-label="Close" onClick={onClose} style={configPanelIconBtnStyle}>
            {'\u2715'}
          </button>
        </div>
      </div>

      {showTabs && (
        <div style={panelTabBarStyle}>
          <button type="button" style={panelTabStyle(activeTab === 'setup')} onClick={() => setActiveTab('setup')}>
            Setup
          </button>
          {showMappingTab && (
            <button type="button" style={panelTabStyle(activeTab === 'mapping')} onClick={() => setActiveTab('mapping')}>
              Field mapping
            </button>
          )}
          {showProfileTab && (
            <button type="button" style={panelTabStyle(activeTab === 'profile')} onClick={() => setActiveTab('profile')}>
              Profile
            </button>
          )}
        </div>
      )}

      <div style={configPanelDetailStyle}>
        {!data.resolved && (
          <div style={configPanelDetailHintStyle}>
            This node references a tool or connection that no longer exists. It can only be removed.
          </div>
        )}

        {showSourceDestForm && (!showTabs || activeTab === 'setup') && (
          <>
            <SourceDestForm
              slot="ribbon"
              config={parsed.value as SourceDestConfig}
              operations={manifest?.operations ?? ['read']}
              nodeType={data.graphNodeType === 'destination' ? 'destination' : 'source'}
              connectionId={data.connectionId}
              manifestId={data.manifestId}
              onChange={(next) => onConfigChange(next)}
            />
            <div style={{ marginTop: 12 }}>
              <SourceDestForm
                slot="detail"
                config={parsed.value as SourceDestConfig}
                operations={manifest?.operations ?? ['read']}
                nodeType={data.graphNodeType === 'destination' ? 'destination' : 'source'}
                connectionId={data.connectionId}
                manifestId={data.manifestId}
                onChange={(next) => onConfigChange(next)}
              />
            </div>
          </>
        )}

        {showTabs && activeTab === 'mapping' && data.resolved && !parsed.unrecognized && (
          <MappingEditor
            config={parsed.value as SourceDestConfig}
            workflowId={workflowId}
            destNodeId={node.id}
            destConnectionId={data.connectionId}
            destManifestId={data.manifestId}
            sourceConnectionId={upstreamSource?.connectionId}
            sourceManifestId={upstreamSource?.manifestId}
            sourceEntity={upstreamSource?.entity}
            sourceFieldsOverride={sourceFieldsOverride}
            checkResults={checkResults}
            onChange={(next) => onConfigChange(next)}
          />
        )}

        {showProfileTab && activeTab === 'profile' && data.connectionId && sourceDestConfig?.entity && (
          <ProfileTab connectionId={data.connectionId} entity={sourceDestConfig.entity} />
        )}

        {data.resolved && data.graphNodeType === 'transform' && !parsed.unrecognized && (
          <TransformEditor
            config={parsed.value as TransformConfig}
            connectionId={upstreamSource?.connectionId}
            manifestId={upstreamSource?.manifestId}
            workflowId={workflowId}
            nodeId={node.id}
            onChange={(next) => onConfigChange(next)}
          />
        )}

        {data.resolved && parsed.unrecognized && (
          <div>
            <div style={{ fontSize: 12.5, color: 'var(--warn)', marginBottom: 8 }}>
              Config from an older format — shown read-only, not modified.
            </div>
            <pre style={{ fontFamily: 'var(--font-data)', fontSize: 11.5, background: 'var(--surface2)', border: '1px solid var(--line2)', borderRadius: 6, padding: 8, whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
              {JSON.stringify(parsed.raw, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
