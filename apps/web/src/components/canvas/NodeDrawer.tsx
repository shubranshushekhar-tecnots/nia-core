'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CONNECTOR_MANIFESTS, WRITE_OPERATIONS, buildDropRoleStatementText, buildGrantStatementText, can, friendlyAppError, friendlyConnectionError, parseNodeConfig, transformOutputFields, type ActorRole, type AgentDeliveryConfig, type AgentDeliveryMode, type CheckResult, type EntityRef, type HelpSqlValues, type Operation, type SourceDestConfig, type TransformConfig } from '@nia/schemas';
import type { CanvasNode } from '@/lib/canvas/mapping';
import { resolveTableFieldState } from '@/lib/canvas/tableFieldState';
import { filterEntities } from '@/lib/canvas/entityFiltering';
import { useCanvasStore } from '@/lib/canvas/store';
import { isAgentSourceManifest, isAgentDestinationManifest } from '@/lib/canvas/agentDelivery';
import {
  confirmWriteGrant,
  ConnectionsApiError,
  createWriteGrant,
  getConnectionSchema,
  getWriteGrants,
  revokeWriteGrant,
  type WriteGrant,
} from '@/lib/api/connectionsClient';
import HelpPanel from '@/components/app/HelpPanel';
import TransformEditor from './TransformEditor';
import MappingEditor from './MappingEditor';
import ProfileTab from './ProfileTab';
import { KIND_COLOR, KIND_LABEL } from './GraphFlowNode';
import { getConnectorIcon } from './icons';
import {
  configPanelAlertCardStyle,
  configPanelDeleteBtnStyle,
  configPanelDetailHintStyle,
  configPanelDetailStyle,
  configPanelDividerStyle,
  configPanelFooterStyle,
  configPanelGroupLabelStyle,
  configPanelGroupStyle,
  configPanelIconBtnStyle,
  configPanelIdentityIconStyle,
  configPanelRibbonStyle,
  configPanelSelectStyle,
  configPanelStatusDotStyle,
  panelTabBarStyle,
  panelTabStyle,
  segmentedControlStyle,
  segmentedOptionStyle,
} from './styles';
import type { NodeStatus, NodeStatusKind } from '@/lib/canvas/mapping';

// Footer status-line palette — same tokens as GraphFlowNode.tsx's on-canvas
// STATUS_STYLE (both read the exact same merged `data.status`), so a node's
// color language never disagrees between the canvas card and its inspector.
const DRAWER_STATUS_STYLE: Record<NodeStatusKind, { dot: string; text: string }> = {
  ready: { dot: 'var(--nx-ink-3)', text: 'var(--nx-ink-2)' },
  running: { dot: 'var(--nx-blue-panel)', text: 'var(--nx-blue-panel)' },
  succeeded: { dot: 'var(--nx-success)', text: 'var(--nx-success)' },
  needsAction: { dot: 'var(--nx-warn)', text: 'var(--nx-warn)' },
  failed: { dot: 'var(--nx-danger)', text: 'var(--nx-danger)' },
  disabled: { dot: 'var(--nx-ink-3)', text: 'var(--nx-ink-3)' },
};

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
 * A manifest's `operations` (e.g. postgres/supabase's `["read", "insert"]`)
 * describes what the connector CAN do, not what a given node's role should
 * offer — a source node reads, a destination node writes, never both. This
 * narrows the manifest's list to the verbs valid for `nodeType`, falling
 * back to the unfiltered list if that role has no matching verb (keeps
 * source-only connectors like mysql/mongodb, whose `operations` is just
 * `["read"]`, working unchanged on source nodes).
 */
function operationsForRole(operations: Operation[], nodeType: 'source' | 'destination'): Operation[] {
  const filtered = operations.filter((op) => (nodeType === 'destination' ? WRITE_OPERATIONS.includes(op) : !WRITE_OPERATIONS.includes(op)));
  return filtered.length > 0 ? filtered : operations;
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
 *
 * Also surfaces isLoading/isError/error distinctly from the entities array
 * itself: `schema.entities` legitimately being `[]` (a real database with
 * zero tables) used to be indistinguishable from "still fetching" or
 * "fetch failed" since all three collapsed to the same `[]` return — the
 * Table field below used entities.length===0 as its sole loading gate,
 * which left it permanently stuck on "Loading tables…" for the empty case.
 */
function useConnectionEntities(connectionId?: string): {
  entities: { namespace: string; name: string; canRead?: boolean; canWrite?: boolean; rlsBlocksRead?: boolean; rlsFixSql?: string | null }[];
  isLoading: boolean;
  isError: boolean;
  error: string | null;
} {
  const { data: schema, isLoading, isError, error } = useQuery({
    queryKey: ['connection-schema', connectionId],
    queryFn: () => getConnectionSchema(connectionId!),
    enabled: !!connectionId,
    staleTime: 5 * 60_000,
  });
  const entities = useMemo(() => {
    if (!schema) return [];
    return schema.entities
      .map((e) => ({ namespace: e.namespace, name: e.name, canRead: e.canRead, canWrite: e.canWrite, rlsBlocksRead: e.rlsBlocksRead, rlsFixSql: e.rlsFixSql }))
      .sort((a, b) => (a.namespace + a.name).localeCompare(b.namespace + b.name));
  }, [schema]);
  return { entities, isLoading, isError, error: error instanceof Error ? error.message : null };
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
  border: '1px solid var(--nx-line)',
  borderRadius: 8,
  background: 'var(--nx-raised)',
} as const;

const grantButtonStyle = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--nx-ink)',
  background: 'var(--nx-surface)',
  border: '1px solid var(--nx-line)',
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
  role,
}: {
  connectionId: string;
  connectorId?: string;
  namespace: string;
  pendingGrant?: WriteGrant;
  role: ActorRole;
}) {
  const queryClient = useQueryClient();
  const canManage = can(role, 'grants.create');
  const [credential] = useState(() => ({ user: randomWriteRoleUser(), password: randomWriteRolePassword() }));
  const [grant, setGrant] = useState<WriteGrant | undefined>(pendingGrant);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorFix, setErrorFix] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const setPendingAgentPrompt = useCanvasStore((s) => s.setPendingAgentPrompt);

  const statementText = connectorId ? buildGrantStatementText(connectorId, namespace, credential.user, credential.password) : null;
  /** The generated role/password already exist at mount (see useState above), so Layer 2's help panel always has real values to show — never the shared placeholder credential. */
  const helpValues: HelpSqlValues = { database: '', namespace, roleUser: credential.user, rolePassword: credential.password };

  async function handleCreate() {
    setBusy(true);
    setError(null);
    setErrorFix(null);
    setErrorDetails(null);
    try {
      const created = await createWriteGrant(connectionId, { schemas: [namespace] });
      setGrant(created);
    } catch (err) {
      // Layer 3, second half (learning-mode plan): CREATE_FAILED is shared
      // with connection creation, whose default help step in
      // friendlyAppError's source-of-truth is "add-connection" — override
      // it to "grant-write-access" here, where it actually happened.
      if (err instanceof ConnectionsApiError && err.code === 'CREATE_FAILED') {
        const { summary, fix, details } = friendlyAppError(err.code, err.message, 'grant-write-access');
        setError(summary);
        setErrorFix(fix ?? null);
        setErrorDetails(details);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to create write grant.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm() {
    if (!grant) return;
    setBusy(true);
    setError(null);
    setErrorFix(null);
    setErrorDetails(null);
    try {
      await confirmWriteGrant(connectionId, grant.id, credential);
      await queryClient.invalidateQueries({ queryKey: ['connection-write-grants', connectionId] });
    } catch (err) {
      // Item 5 (fix-chain plan): WRITE_GRANT_TEST_FAILED carries the write
      // credential's own raw connector test-connect error (grants.ts's
      // confirmWriteGrant) — pattern-match it into a friendly summary, same
      // as the standalone "Test" button. Other confirm failures (e.g. a
      // Vault write or DB update error) aren't raw driver text, so they
      // pass through as-is.
      if (err instanceof ConnectionsApiError && err.code === 'WRITE_GRANT_TEST_FAILED') {
        const { summary, fix, details } = friendlyConnectionError(err.message);
        setError(summary);
        setErrorFix(fix ?? null);
        setErrorDetails(details);
      } else if (err instanceof ConnectionsApiError && err.code === 'CONFIRM_FAILED') {
        const { summary, fix, details } = friendlyAppError(err.code, err.message);
        setError(summary);
        setErrorFix(fix ?? null);
        setErrorDetails(details);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to confirm write grant.');
      }
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

  // Subscription Phase 2, Slice 5 (DECISION-F, docs/decisions.md):
  // grants.create/confirm are admin/owner only. A member/viewer sees the
  // same header (help panel + Ask Copilot stay available) but the
  // action area — button, statement text, everything progress-related —
  // is replaced with a read-only notice, regardless of whether a grant is
  // already pending confirmation (confirm is gated the same way).
  if (!canManage) {
    return (
      <div style={grantPanelStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--nx-ink)' }}>Grant write access to &quot;{namespace}&quot;</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              style={grantButtonStyle}
              onClick={() =>
                setPendingAgentPrompt(`[Connection: ${connectionId}, namespace: ${namespace}] Explain the write grant for this step.`)
              }
            >
              Ask Copilot about this step
            </button>
            <button type="button" style={grantButtonStyle} onClick={() => setShowHelp(true)}>
              Help with this step
            </button>
          </div>
        </div>
        {showHelp && (
          <HelpPanel step="grant-write-access" connectorId={connectorId ?? ''} values={helpValues} onClose={() => setShowHelp(false)} />
        )}
        <div style={{ fontSize: 11.5, color: 'var(--nx-ink-disabled)' }}>Ask an admin or owner to grant write access.</div>
      </div>
    );
  }

  return (
    <div style={grantPanelStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--nx-ink)' }}>Grant write access to &quot;{namespace}&quot;</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            style={grantButtonStyle}
            onClick={() =>
              setPendingAgentPrompt(`[Connection: ${connectionId}, namespace: ${namespace}] Explain the write grant for this step.`)
            }
          >
            Ask Copilot about this step
          </button>
          <button type="button" style={grantButtonStyle} onClick={() => setShowHelp(true)}>
            Help with this step
          </button>
        </div>
      </div>
      {showHelp && (
        <HelpPanel step="grant-write-access" connectorId={connectorId ?? ''} values={helpValues} onClose={() => setShowHelp(false)} />
      )}
      {!grant ? (
        <>
          <div style={{ fontSize: 11.5, color: 'var(--nx-ink-disabled)', marginBottom: 8 }}>
            Mints a role/password for this schema and shows a statement to run against your database.
          </div>
          <button type="button" style={grantButtonStyle} disabled={busy} onClick={handleCreate}>
            {busy ? 'Creating…' : 'Grant write access'}
          </button>
        </>
      ) : !grant.confirmedAt ? (
        <>
          <div style={{ fontSize: 11.5, color: 'var(--nx-ink-disabled)', marginBottom: 6 }}>
            Run this against the connection&apos;s database, then confirm below.
          </div>
          {statementText ? (
            <>
              <pre
                role="region"
                aria-label="Grant write access SQL statement"
                tabIndex={0}
                style={{
                  fontFamily: 'var(--nx-font-mono)',
                  fontSize: 11,
                  background: 'var(--nx-surface)',
                  border: '1px solid var(--nx-line)',
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
            <div style={{ fontSize: 11.5, color: 'var(--nx-warn)', marginBottom: 8 }}>No statement text for this connector yet — ask your database admin.</div>
          )}
          <button type="button" style={grantButtonStyle} disabled={busy} onClick={handleConfirm}>
            {busy ? 'Confirming…' : "I've run this — confirm access"}
          </button>
        </>
      ) : (
        <div style={{ fontSize: 11.5, color: 'var(--nx-success)' }}>Confirmed.</div>
      )}
      {error && (
        <div style={{ fontSize: 11.5, color: 'var(--nx-danger)', marginTop: 6 }}>
          {error}
          {errorFix && <span style={{ display: 'block', marginTop: 2 }}>{errorFix}</span>}
          {errorDetails && errorDetails !== error && (
            <details style={{ marginTop: 4 }}>
              <summary style={{ cursor: 'pointer' }}>Show details</summary>
              <span style={{ display: 'block', marginTop: 2 }}>{errorDetails}</span>
            </details>
          )}
        </div>
      )}
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
function RevokeAccessPanel({
  connectionId,
  connectorId,
  grant,
  namespace,
}: {
  connectionId: string;
  connectorId?: string;
  grant: WriteGrant;
  namespace: string;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorFix, setErrorFix] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const setPendingAgentPrompt = useCanvasStore((s) => s.setPendingAgentPrompt);

  const dropStatement =
    connectorId && grant.writeRoleName ? buildDropRoleStatementText(connectorId, grant.writeRoleName) : null;
  /** Only real once the grant actually carries a role name — falls back to HelpPanel's illustration mode (no Copy button) otherwise, same invariant as GrantAccessPanel above. */
  const helpValues: HelpSqlValues | undefined = grant.writeRoleName
    ? { database: '', namespace, roleUser: grant.writeRoleName, rolePassword: '' }
    : undefined;

  async function handleRevoke() {
    setBusy(true);
    setError(null);
    setErrorFix(null);
    setErrorDetails(null);
    try {
      await revokeWriteGrant(connectionId, grant.id);
      await queryClient.invalidateQueries({ queryKey: ['connection-write-grants', connectionId] });
    } catch (err) {
      if (err instanceof ConnectionsApiError && err.code === 'REVOKE_FAILED') {
        const { summary, fix, details } = friendlyAppError(err.code, err.message);
        setError(summary);
        setErrorFix(fix ?? null);
        setErrorDetails(details);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to revoke write grant.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy() {
    if (!dropStatement) return;
    await navigator.clipboard.writeText(dropStatement);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div style={grantPanelStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8, gap: 8 }}>
        <div style={{ fontSize: 11.5, color: 'var(--nx-success)' }}>
          Write access granted to &quot;{namespace}&quot;{grant.writeRoleName ? <> as role <code>{grant.writeRoleName}</code></> : null}.
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button
            type="button"
            style={grantButtonStyle}
            onClick={() =>
              setPendingAgentPrompt(`[Connection: ${connectionId}, namespace: ${namespace}] Explain the write grant for this step.`)
            }
          >
            Ask Copilot about this step
          </button>
          <button type="button" style={grantButtonStyle} onClick={() => setShowHelp(true)}>
            Help with this step
          </button>
        </div>
      </div>
      {showHelp && (
        <HelpPanel step="revoke-access" connectorId={connectorId ?? ''} values={helpValues} onClose={() => setShowHelp(false)} />
      )}
      {dropStatement && (
        <details style={{ marginBottom: 8 }}>
          <summary style={{ fontSize: 11.5, color: 'var(--nx-ink-disabled)', cursor: 'pointer' }}>Show role removal statement</summary>
          <pre
            role="region"
            aria-label="Drop role SQL statement"
            tabIndex={0}
            style={{
              fontFamily: 'var(--nx-font-mono)',
              fontSize: 11,
              background: 'var(--nx-surface)',
              border: '1px solid var(--nx-line)',
              borderRadius: 6,
              padding: 8,
              whiteSpace: 'pre-wrap',
              overflowX: 'auto',
              marginTop: 6,
              marginBottom: 6,
            }}
          >
            {dropStatement}
          </pre>
          <button type="button" style={{ ...grantButtonStyle, marginRight: 8 }} onClick={handleCopy}>
            {copied ? 'Copied' : 'Copy statement'}
          </button>
        </details>
      )}
      <button type="button" style={grantButtonStyle} disabled={busy} onClick={handleRevoke}>
        {busy ? 'Revoking…' : 'Revoke access'}
      </button>
      {error && (
        <div style={{ fontSize: 11.5, color: 'var(--nx-danger)', marginTop: 6 }}>
          {error}
          {errorFix && <span style={{ display: 'block', marginTop: 2 }}>{errorFix}</span>}
          {errorDetails && errorDetails !== error && (
            <details style={{ marginTop: 4 }}>
              <summary style={{ cursor: 'pointer' }}>Show details</summary>
              <span style={{ display: 'block', marginTop: 2 }}>{errorDetails}</span>
            </details>
          )}
        </div>
      )}
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
  role,
  onChange,
}: {
  slot: 'ribbon' | 'detail';
  config: SourceDestConfig;
  operations: Operation[];
  nodeType: 'source' | 'destination';
  connectionId?: string;
  manifestId?: string;
  role: ActorRole;
  onChange: (next: SourceDestConfig) => void;
}) {
  const { entities, isLoading: entitiesLoading, isError: entitiesError, error: entitiesErrorMessage } = useConnectionEntities(connectionId);
  const grants = useWriteGrants(connectionId);
  const grantedNamespaces = useGrantedNamespaces(grants);
  /** Schema layer Part 4's "type a new name" toggle — see NewTargetInputs's doc comment. Declared unconditionally (before the slot==='detail' early return below) since this component renders twice (ribbon + detail slots) and hooks must stay in the same order every render. */
  const [newTargetMode, setNewTargetMode] = useState(false);
  /** "Show system schemas" toggle — off by default, same unconditional-declaration reasoning as newTargetMode above. See entityFiltering.ts's SYSTEM_SCHEMAS for what this reveals (vault/nia stay hidden regardless). */
  const [showSystemSchemas, setShowSystemSchemas] = useState(false);
  const visibleEntities = useMemo(
    () => filterEntities(entities, { nodeType, showSystemSchemas }),
    [entities, nodeType, showSystemSchemas],
  );
  const selectedKey = config.entity ? entityKey(config.entity) : '';
  const selectedEntity = config.entity ? entities.find((e) => entityKey(e) === selectedKey) : undefined;
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

  // Self-heals nodes persisted before role-appropriate verbs existed (or any
  // node whose stored `operation` otherwise falls outside this role's valid
  // list) — e.g. a destination node saved back when only "read" was ever
  // offered. Guarded to the ribbon slot only (this component renders twice
  // per node, ribbon + detail) so it fires once per mount, not twice. The
  // `operations.includes` check makes this idempotent: after the corrective
  // onChange, the next run is a no-op.
  useEffect(() => {
    if (slot !== 'ribbon') return;
    if (operations.length === 0) return;
    if (!operations.includes(config.operation)) {
      onChange({ ...config, operation: operations[0]! });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot, operations.join(','), config.operation]);

  if (slot === 'detail') {
    if (nodeType !== 'destination' || !connectionId || namespace === undefined) return null;
    if (!grantCovers) {
      return <GrantAccessPanel connectionId={connectionId} connectorId={manifestId} namespace={namespace} pendingGrant={pendingGrant} role={role} />;
    }
    if (activeGrant) {
      return <RevokeAccessPanel connectionId={connectionId} connectorId={manifestId} grant={activeGrant} namespace={namespace} />;
    }
    return null;
  }

  // Phase 6 Block 2: a write verb unlocks once the node's connection has a
  // confirmed, unrevoked write grant covering the selected entity's
  // namespace — mirrors checkGrants' server-side pass condition exactly
  // (@nia/schemas/checks.ts). This is layer 1 of the three-layer guardrail;
  // the connector service and its actual DB privileges (layers 2/3) still
  // enforce this independently. Same reason applies to every locked verb
  // (doesn't vary by op), so it's computed once here — Item 5 (fix-chain
  // plan) renders this as visible inline text next to the disabled verb(s),
  // not only as a `title` tooltip (which is easy to miss/not discoverable
  // on touch devices).
  const lockedReason = !namespace
    ? 'Select a table with an active write grant to unlock this verb.'
    : `Requires a confirmed write grant covering "${namespace}".`;
  const anyVerbLocked = operations.some((op) => WRITE_OPERATIONS.includes(op) && !grantCovers);

  return (
    <>
      <div style={configPanelGroupStyle}>
        <span style={configPanelGroupLabelStyle}>Verb</span>
        <div role="radiogroup" aria-label="Verb" style={segmentedControlStyle}>
          {operations.map((op) => {
            const isWriteOp = WRITE_OPERATIONS.includes(op);
            const locked = isWriteOp && !grantCovers;
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
        {anyVerbLocked && <span style={{ fontSize: 10.5, color: 'var(--nx-ink-disabled)', marginTop: 4, display: 'block' }}>{lockedReason}</span>}
      </div>

      <div style={configPanelDividerStyle} />

      <div style={configPanelGroupStyle}>
        <label htmlFor="node-drawer-table-select" style={configPanelGroupLabelStyle}>
          Table
        </label>
        {(() => {
          const state = resolveTableFieldState({
            connectionId,
            newTargetMode,
            isLoading: entitiesLoading,
            isError: entitiesError,
            errorMessage: entitiesErrorMessage,
          });
          if (state.kind === 'select-connection') {
            return <span style={{ fontSize: 12, color: 'var(--nx-ink-disabled)', whiteSpace: 'nowrap' }}>Select a connection first.</span>;
          }
          if (state.kind === 'new-target') {
            return <NewTargetInputs entity={config.entity} onChange={(entity) => onChange({ ...config, entity })} onCancel={() => setNewTargetMode(false)} />;
          }
          if (state.kind === 'loading') {
            return <span style={{ fontSize: 12, color: 'var(--nx-ink-disabled)', whiteSpace: 'nowrap' }}>Loading tables…</span>;
          }
          if (state.kind === 'error') {
            return <span style={{ fontSize: 12, color: 'var(--nx-danger)' }}>{state.message}</span>;
          }
          // state.kind === 'select' — entities may legitimately be [] here (a
          // real database with zero tables); the select still renders so
          // destination nodes can reach "+ Create new…" below.
          return (
            <>
              <select
                id="node-drawer-table-select"
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
                {visibleEntities.map((e) => (
                  <option key={entityKey(e)} value={entityKey(e)}>
                    {(e.namespace ? `${e.namespace}.${e.name}` : e.name) + (nodeType === 'source' && e.rlsBlocksRead ? ' (RLS: 0 rows)' : '')}
                  </option>
                ))}
                {/* Schema layer Part 4: "choose an existing target or type a new name" — destination only, since ensureDestination.ts (apps/worker) auto-creates a missing destination target from the contract, but a source still requires a pre-existing table to read from. */}
                {nodeType === 'destination' && <option value={NEW_TARGET_SENTINEL}>+ Create new…</option>}
              </select>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--nx-ink-disabled)', marginTop: 6 }}>
                <input type="checkbox" checked={showSystemSchemas} onChange={(e) => setShowSystemSchemas(e.target.checked)} />
                Show system schemas
              </label>
              {nodeType === 'source' && selectedEntity?.rlsBlocksRead && (
                <>
                  <span style={{ fontSize: 12, color: 'var(--nx-danger)', display: 'block', marginTop: 4 }}>
                    Row-level security is enabled on this table with no policy covering this connection&apos;s role — reads will return 0 rows.
                  </span>
                  {selectedEntity.rlsFixSql && (
                    <pre
                      style={{
                        fontFamily: 'var(--nx-font-mono)',
                        fontSize: 11,
                        background: 'var(--nx-raised)',
                        border: '1px solid var(--nx-line)',
                        borderRadius: 6,
                        padding: 8,
                        whiteSpace: 'pre-wrap',
                        overflowX: 'auto',
                        marginTop: 6,
                      }}
                    >
                      {selectedEntity.rlsFixSql}
                    </pre>
                  )}
                </>
              )}
            </>
          );
        })()}
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
        style={{ ...configPanelSelectStyle, width: 90, fontFamily: 'var(--nx-font-mono)' }}
      />
      <span style={{ color: 'var(--nx-ink-disabled)', fontSize: 12 }}>.</span>
      <input
        value={entity?.name ?? ''}
        onChange={(e) => onChange({ namespace: entity?.namespace ?? '', name: e.target.value })}
        placeholder="new table name"
        style={{ ...configPanelSelectStyle, flex: 1, fontFamily: 'var(--nx-font-mono)' }}
      />
      <button
        type="button"
        aria-label="Back to existing tables"
        onClick={onCancel}
        style={{ border: 'none', background: 'none', color: 'var(--nx-ink-disabled)', cursor: 'pointer', fontSize: 12, padding: 0 }}
      >
        {'\u2715'}
      </button>
    </div>
  );
}

/**
 * Agent-Canvas integration, Slice R4 (B.7, item 1) — shares the schema
 * query (`['connection-schema', connectionId]`) with useConnectionEntities
 * above, so this never double-fetches: it just reads the full field list
 * (name+type) for whichever entity is already selected, which
 * useConnectionEntities' own stripped-down return type doesn't carry.
 */
function useEntityFields(connectionId: string | undefined, entity: EntityRef | undefined): { name: string; type: string }[] {
  const { data: schema } = useQuery({
    queryKey: ['connection-schema', connectionId],
    queryFn: () => getConnectionSchema(connectionId!),
    enabled: !!connectionId,
    staleTime: 5 * 60_000,
  });
  return useMemo(() => {
    if (!schema || !entity) return [];
    const match = schema.entities.find((e) => e.namespace === entity.namespace && e.name === entity.name);
    return match?.fields.map((f) => ({ name: f.name, type: f.type })) ?? [];
  }, [schema, entity]);
}

const ROLLING_DATE_TOKENS = ['today', 'today-Nd', 'startOfMonth', 'startOfMonth-Nm', 'startOfYear', 'startOfYear-Ny'];

/**
 * Agent-Canvas integration, Slice R4 (B.7, item 1) — the agent-delivered
 * source's column selection + saved parameters, rendered only once a table
 * is selected on a "Local database (via agent)" source node. Reads/writes
 * SourceDestConfig.columns/params straight through the same onChange prop
 * every other section of this drawer already uses — no new persistence
 * path. A saved parameter's value is a plain string either way (a literal,
 * or one of the rolling-date tokens typed as literal text, e.g.
 * "today-7d") — resolved only by the agent at run time (see
 * SourceDestConfig.params' doc comment); a filter condition elsewhere on
 * this workflow references one of these by simply using the same name as
 * its value (deriveAgentJobSetupFromGraph.test.ts's "Allowed" case).
 */
function AgentSourceColumnsPanel({
  connectionId,
  entity,
  config,
  onChange,
}: {
  connectionId?: string;
  entity?: EntityRef;
  config: SourceDestConfig;
  onChange: (next: SourceDestConfig) => void;
}) {
  const fields = useEntityFields(connectionId, entity);
  const columns = config.columns ?? [];
  const params = config.params ?? {};

  function toggleColumn(field: { name: string; type: string }) {
    const existing = columns.find((c) => c.name === field.name);
    const next = existing ? columns.filter((c) => c.name !== field.name) : [...columns, { name: field.name, type: field.type, isKey: false }];
    onChange({ ...config, columns: next });
  }

  function toggleKey(name: string) {
    onChange({ ...config, columns: columns.map((c) => (c.name === name ? { ...c, isKey: !c.isKey } : c)) });
  }

  function setParamValue(name: string, value: string) {
    onChange({ ...config, params: { ...params, [name]: value } });
  }

  function removeParam(name: string) {
    const next = { ...params };
    delete next[name];
    onChange({ ...config, params: next });
  }

  function addParam() {
    let name = 'param';
    let i = 1;
    while (name in params) name = `param${i++}`;
    onChange({ ...config, params: { ...params, [name]: '' } });
  }

  function renameParam(oldName: string, newName: string) {
    if (!newName || newName === oldName || newName in params) return;
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) next[k === oldName ? newName : k] = v;
    onChange({ ...config, params: next });
  }

  if (!entity) return null;

  return (
    <div style={{ marginTop: 12 }}>
      <div style={configPanelDividerStyle} />
      <div style={configPanelGroupStyle}>
        <span style={configPanelGroupLabelStyle}>Columns</span>
        {fields.length === 0 ? (
          <span style={{ fontSize: 11.5, color: 'var(--nx-ink-disabled)' }}>Loading columns…</span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
            {fields.map((field) => {
              const selected = columns.find((c) => c.name === field.name);
              return (
                <div key={field.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--nx-ink)', cursor: 'pointer', flex: 1 }}>
                    <input type="checkbox" checked={!!selected} onChange={() => toggleColumn(field)} />
                    <span style={{ fontFamily: 'var(--nx-font-mono)' }}>{field.name}</span>
                    <span style={{ color: 'var(--nx-ink-disabled)', fontSize: 11 }}>{field.type}</span>
                  </label>
                  {selected && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--nx-ink-disabled)' }}>
                      <input type="checkbox" checked={selected.isKey} onChange={() => toggleKey(field.name)} />
                      Key
                    </label>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div style={configPanelDividerStyle} />

      <div style={configPanelGroupStyle}>
        <span style={configPanelGroupLabelStyle}>Saved parameters</span>
        <span style={{ fontSize: 11, color: 'var(--nx-ink-disabled)', marginBottom: 6, display: 'block' }}>
          Reference by name as a filter condition&apos;s value below. Value is a literal, or a rolling date token: {ROLLING_DATE_TOKENS.join(', ')}.
        </span>
        {Object.entries(params).map(([name, value]) => (
          <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <input
              value={name}
              onChange={(e) => renameParam(name, e.target.value)}
              placeholder="name"
              style={{ ...configPanelSelectStyle, width: 110, fontFamily: 'var(--nx-font-mono)' }}
            />
            <input
              value={value}
              onChange={(e) => setParamValue(name, e.target.value)}
              placeholder="value or token"
              style={{ ...configPanelSelectStyle, flex: 1, fontFamily: 'var(--nx-font-mono)' }}
            />
            <button
              type="button"
              aria-label={`Remove ${name}`}
              onClick={() => removeParam(name)}
              style={{ border: 'none', background: 'none', color: 'var(--nx-danger)', cursor: 'pointer', fontSize: 12, padding: 0 }}
            >
              {'\u2715'}
            </button>
          </div>
        ))}
        <button type="button" onClick={addParam} style={grantButtonStyle}>
          + Add parameter
        </button>
      </div>
    </div>
  );
}

/** Slice R4 (B.7, item 4) — mode labels/options differ per destination manifest even though AgentDeliveryMode's underlying enum values are shared (nodeConfig.ts's AgentDeliveryMode doc comment: it mirrors agentJobSetup.ts's AgentJobSetupMode exactly). */
const AGENT_DELIVERY_MODE_OPTIONS: Record<string, { value: AgentDeliveryMode; label: string }[]> = {
  'planometry-table': [
    { value: 'replace', label: 'Replace' },
    { value: 'upsertDelta', label: 'Upsert' },
    { value: 'realtime', label: 'Real time' },
  ],
  'https-endpoint': [
    { value: 'replace', label: 'Send all' },
    { value: 'upsertDelta', label: 'Send changed' },
  ],
};

const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: 'Every 5 minutes', cron: '*/5 * * * *' },
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Every 30 minutes', cron: '*/30 * * * *' },
  { label: 'Hourly', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Daily at midnight', cron: '0 0 * * *' },
];
const CUSTOM_CRON_SENTINEL = '__custom__';

/** A friendly-presets-plus-custom-cron picker (B.7 item 4's "schedule with a few friendly presets") — shared by Delivery.schedule and .replaceSchedule below. */
function CronScheduleField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string | undefined;
  onChange: (next: string | undefined) => void;
}) {
  const matchedPreset = CRON_PRESETS.find((p) => p.cron === value);
  const [customMode, setCustomMode] = useState(!!value && !matchedPreset);
  return (
    <div style={configPanelGroupStyle}>
      <span style={configPanelGroupLabelStyle}>{label}</span>
      <select
        value={customMode ? CUSTOM_CRON_SENTINEL : (matchedPreset?.cron ?? '')}
        onChange={(e) => {
          if (e.target.value === CUSTOM_CRON_SENTINEL) {
            setCustomMode(true);
            return;
          }
          setCustomMode(false);
          onChange(e.target.value || undefined);
        }}
        style={configPanelSelectStyle}
      >
        <option value="">Not scheduled</option>
        {CRON_PRESETS.map((p) => (
          <option key={p.cron} value={p.cron}>
            {p.label}
          </option>
        ))}
        <option value={CUSTOM_CRON_SENTINEL}>Custom…</option>
      </select>
      {customMode && (
        <input
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          placeholder="5-field cron expression"
          style={{ ...configPanelSelectStyle, fontFamily: 'var(--nx-font-mono)', marginTop: 6 }}
        />
      )}
      {hint && <span style={{ fontSize: 10.5, color: 'var(--nx-ink-disabled)', marginTop: 4, display: 'block' }}>{hint}</span>}
    </div>
  );
}

/**
 * Agent-Canvas integration, Slice R4 (B.7, item 4) — the agent-delivered
 * destination's "Delivery" section: everything about how the agent pushes
 * rows (SourceDestConfig.delivery), as opposed to the Field mapping tab's
 * "what gets pushed". Rendered only for a Planometry table or HTTPS
 * endpoint destination node. Shows only the fields valid for the chosen
 * destination manifest + mode, per the task's "show only the options valid
 * for the chosen destination and mode."
 */
function AgentDeliverySection({
  manifestId,
  config,
  onChange,
}: {
  manifestId: string;
  config: SourceDestConfig;
  onChange: (next: SourceDestConfig) => void;
}) {
  const delivery: AgentDeliveryConfig = config.delivery ?? {};
  const modeOptions = AGENT_DELIVERY_MODE_OPTIONS[manifestId] ?? [];
  const mode = delivery.mode;

  function set(patch: Partial<AgentDeliveryConfig>) {
    onChange({ ...config, delivery: { ...delivery, ...patch } });
  }

  const showWatermark = mode === 'upsertDelta' || mode === 'realtime';
  const showSchedule = mode === 'replace' || mode === 'upsertDelta';
  const showReplaceSchedule = mode === 'upsertDelta' || mode === 'realtime';
  const showPollInterval = mode === 'realtime';
  const showAllowEmptyReplace = mode === 'replace';

  return (
    <div style={{ marginTop: 12 }}>
      <div style={configPanelDividerStyle} />
      <span style={{ ...configPanelGroupLabelStyle, display: 'block', marginBottom: 8 }}>Delivery</span>

      <div style={configPanelGroupStyle}>
        <span style={configPanelGroupLabelStyle}>Mode</span>
        <select
          value={mode ?? ''}
          onChange={(e) => set({ mode: (e.target.value || undefined) as AgentDeliveryMode | undefined })}
          style={configPanelSelectStyle}
        >
          <option value="">Choose a mode…</option>
          {modeOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {showWatermark && (
        <div style={configPanelGroupStyle}>
          <span style={configPanelGroupLabelStyle}>Last-modified column</span>
          <input
            value={delivery.watermarkColumn ?? ''}
            onChange={(e) => set({ watermarkColumn: e.target.value || undefined })}
            placeholder="e.g. updated_at"
            style={{ ...configPanelSelectStyle, fontFamily: 'var(--nx-font-mono)' }}
          />
        </div>
      )}

      <div style={configPanelGroupStyle}>
        <span style={configPanelGroupLabelStyle}>Delete method</span>
        <select
          value={delivery.deleteMode ?? 'none'}
          onChange={(e) => set({ deleteMode: e.target.value as AgentDeliveryConfig['deleteMode'] })}
          style={configPanelSelectStyle}
        >
          <option value="none">None</option>
          <option value="reconciliation">Reconciliation</option>
          <option value="softDelete">Soft delete</option>
        </select>
      </div>

      {delivery.deleteMode === 'softDelete' && (
        <div style={configPanelGroupStyle}>
          <span style={configPanelGroupLabelStyle}>Soft-delete flag column</span>
          <input
            value={delivery.softDeleteColumn ?? ''}
            onChange={(e) => set({ softDeleteColumn: e.target.value || undefined })}
            placeholder="e.g. is_deleted"
            style={{ ...configPanelSelectStyle, fontFamily: 'var(--nx-font-mono)' }}
          />
        </div>
      )}

      {delivery.deleteMode === 'reconciliation' && (
        <div style={configPanelGroupStyle}>
          <span style={configPanelGroupLabelStyle}>Maximum delete percent</span>
          <input
            type="number"
            min={0}
            max={100}
            value={delivery.maxDeletePercent ?? ''}
            onChange={(e) => set({ maxDeletePercent: e.target.value === '' ? undefined : Number(e.target.value) })}
            style={{ ...configPanelSelectStyle, width: 100 }}
          />
        </div>
      )}

      <div style={configPanelGroupStyle}>
        <span style={configPanelGroupLabelStyle}>Empty keys</span>
        <select
          value={delivery.onNullKey ?? 'stop'}
          onChange={(e) => set({ onNullKey: e.target.value as AgentDeliveryConfig['onNullKey'] })}
          style={configPanelSelectStyle}
        >
          <option value="stop">Stop the run</option>
          <option value="skip">Skip the row</option>
        </select>
      </div>

      {showAllowEmptyReplace && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--nx-ink)', marginTop: 4, cursor: 'pointer' }}>
          <input type="checkbox" checked={!!delivery.allowEmptyReplace} onChange={(e) => set({ allowEmptyReplace: e.target.checked })} />
          Allow an empty full load
        </label>
      )}

      {showSchedule && (
        <CronScheduleField
          label={mode === 'replace' ? 'Schedule' : 'Delta schedule'}
          value={delivery.schedule}
          onChange={(next) => set({ schedule: next })}
        />
      )}

      {showReplaceSchedule && (
        <CronScheduleField
          label="Full-reload schedule"
          hint="A periodic full replace, independent of the delta schedule above."
          value={delivery.replaceSchedule}
          onChange={(next) => set({ replaceSchedule: next })}
        />
      )}

      {showPollInterval && (
        <div style={configPanelGroupStyle}>
          <span style={configPanelGroupLabelStyle}>Check interval (seconds)</span>
          <input
            type="number"
            min={1}
            value={delivery.pollIntervalSeconds ?? ''}
            onChange={(e) => set({ pollIntervalSeconds: e.target.value === '' ? undefined : Number(e.target.value) })}
            style={{ ...configPanelSelectStyle, width: 100 }}
          />
        </div>
      )}
    </div>
  );
}

export default function NodeDrawer({
  node,
  role,
  workflowId,
  upstreamSource,
  checkResults,
  onConfigChange,
  onDelete,
  onClose,
}: {
  node: CanvasNode;
  role: ActorRole;
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
  const identityColor = data.resolved ? KIND_COLOR[data.graphNodeType] : 'var(--nx-warn)';
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
        {/* flex: '1 1 0%' + minWidth: 0 (not the shared configPanelGroupStyle's
            flex: 'none') — this group must bound its own width so a long
            connectionLabel (below) genuinely wraps onto a second line instead
            of overflowing the ribbon. Absorbing the leftover width here also
            makes the old empty spacer div redundant (removed). */}
        <div style={{ ...configPanelGroupStyle, flex: '1 1 0%', minWidth: 0 }}>
          <span style={configPanelGroupLabelStyle}>{KIND_LABEL[data.graphNodeType]}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }} title={identityTitle}>
            <span style={configPanelIdentityIconStyle(identityColor)} aria-hidden>
              <IdentityIcon size={13} />
            </span>
            <span
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: data.resolved ? 'var(--nx-ink)' : 'var(--nx-warn)',
                maxWidth: 140,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {identityName}
            </span>
            {data.connectionLabel && (
              // Connection names are frequently literal hostnames (e.g. an
              // RDS endpoint) — wraps instead of truncating so the full
              // host is always visible, never cut off mid-string.
              <span
                style={{
                  fontSize: 11,
                  color: 'var(--nx-ink-disabled)',
                  whiteSpace: 'normal',
                  wordBreak: 'break-word',
                  minWidth: 0,
                }}
              >
                · {data.connectionLabel}
              </span>
            )}
          </div>
        </div>

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

        {/* Prominent inline callout for a real check failure/warning — the
            footer strip below is easy to miss, so needsAction/failed also
            surface here, at the top of Setup, where the fix (e.g. a grant)
            actually happens. Same data.status the on-canvas node footer
            reads, so the two never disagree. */}
        {data.resolved && (!showTabs || activeTab === 'setup') && data.status && (data.status.kind === 'needsAction' || data.status.kind === 'failed') && (
          <div style={configPanelAlertCardStyle(data.status.kind === 'failed' ? 'danger' : 'warning')}>
            <span aria-hidden>{data.status.kind === 'failed' ? '\u2716' : '\u26A0'}</span>
            <span>{data.status.message}</span>
          </div>
        )}

        {showSourceDestForm && (!showTabs || activeTab === 'setup') && (
          <>
            <SourceDestForm
              slot="ribbon"
              config={parsed.value as SourceDestConfig}
              operations={operationsForRole(manifest?.operations ?? ['read'], data.graphNodeType === 'destination' ? 'destination' : 'source')}
              nodeType={data.graphNodeType === 'destination' ? 'destination' : 'source'}
              connectionId={data.connectionId}
              manifestId={data.manifestId}
              role={role}
              onChange={(next) => onConfigChange(next)}
            />
            <div style={{ marginTop: 12 }}>
              <SourceDestForm
                slot="detail"
                config={parsed.value as SourceDestConfig}
                operations={operationsForRole(manifest?.operations ?? ['read'], data.graphNodeType === 'destination' ? 'destination' : 'source')}
                nodeType={data.graphNodeType === 'destination' ? 'destination' : 'source'}
                connectionId={data.connectionId}
                manifestId={data.manifestId}
                role={role}
                onChange={(next) => onConfigChange(next)}
              />
            </div>

            {data.graphNodeType === 'source' && isAgentSourceManifest(data.manifestId) && sourceDestConfig && (
              <AgentSourceColumnsPanel
                connectionId={data.connectionId}
                entity={sourceDestConfig.entity}
                config={sourceDestConfig}
                onChange={(next) => onConfigChange(next)}
              />
            )}

            {data.graphNodeType === 'destination' && isAgentDestinationManifest(data.manifestId) && sourceDestConfig && (
              <AgentDeliverySection
                manifestId={data.manifestId!}
                config={sourceDestConfig}
                onChange={(next) => onConfigChange(next)}
              />
            )}
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
            restrictToFilterOnly={isAgentSourceManifest(upstreamSource?.manifestId)}
            onChange={(next) => onConfigChange(next)}
          />
        )}

        {data.resolved && parsed.unrecognized && (
          <div>
            <div style={{ fontSize: 12.5, color: 'var(--nx-warn)', marginBottom: 8 }}>
              Config from an older format — shown read-only, not modified.
            </div>
            <pre style={{ fontFamily: 'var(--nx-font-mono)', fontSize: 11.5, background: 'var(--nx-raised)', border: '1px solid var(--nx-line)', borderRadius: 6, padding: 8, whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
              {JSON.stringify(parsed.raw, null, 2)}
            </pre>
          </div>
        )}
      </div>

      {/* Live status footer — mirrors GraphFlowNode.tsx's on-canvas footer
          (same data.status merge pass), so the inspector and the card never
          disagree. Falls back to "ready" until the first applyCheckResults
          merge pass has run (e.g. a brand-new node). */}
      <div style={configPanelFooterStyle}>
        <span style={configPanelStatusDotStyle(DRAWER_STATUS_STYLE[data.status?.kind ?? 'ready'].dot)} aria-hidden />
        <span style={{ color: DRAWER_STATUS_STYLE[data.status?.kind ?? 'ready'].text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {data.status?.message ?? 'Ready'}
        </span>
      </div>
    </div>
  );
}
