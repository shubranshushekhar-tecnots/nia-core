'use client';

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CONNECTOR_MANIFESTS, WRITE_OPERATIONS, buildGrantStatementText, parseNodeConfig, type CheckResult, type EntityRef, type Operation, type SourceDestConfig, type TransformConfig } from '@nia/schemas';
import type { CanvasNode } from '@/lib/canvas/mapping';
import { confirmWriteGrant, createWriteGrant, getConnectionSchema, getWriteGrants, revokeWriteGrant, type WriteGrant } from '@/lib/api/connectionsClient';
import TransformEditor from './TransformEditor';
import MappingEditor from './MappingEditor';

/**
 * Node properties drawer — docked to the canvas's right edge, replacing
 * NodeConfigPanel.tsx (dead code: it imported a `CanvasNode` shape from
 * lib/dashboard/types that no longer matches this canvas's actual node
 * data at all — never wired to any click handler, confirmed via grep
 * before writing this). Content branches on the node's resolution/type:
 *   - unresolved ("unknown tool")  -> read-only, delete-only
 *   - source / destination         -> verb selector, write verbs locked
 *   - transform                    -> TransformEditor (filter/computed/drop)
 */

/* Outer box chrome (position/width/border/shadow/scroll region) now lives on
   NodePopover.tsx's NodeToolbar wrapper (styles.ts's nodePopoverShellStyle) —
   this component is rendered inside that shell, not as its own floating
   panel, so this stays padding-only. Everything below this const is
   unchanged from before the popover restructure. */
const drawerStyle = {
  padding: 16,
  boxSizing: 'border-box',
} as const;

const sectionHeaderStyle = {
  fontSize: 11.5,
  fontWeight: 600,
  color: 'var(--ink4)',
  textTransform: 'uppercase',
  letterSpacing: '.04em',
  marginBottom: 8,
} as const;

const lockedBadgeStyle = {
  marginLeft: 6,
  fontSize: 10,
  fontWeight: 600,
  color: 'var(--warn)',
  background: 'var(--warn-bg)',
  border: '1px solid var(--warn-bd)',
  borderRadius: 999,
  padding: '1px 6px',
} as const;

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

function SourceDestForm({
  config,
  operations,
  nodeType,
  connectionId,
  manifestId,
  onChange,
}: {
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

  return (
    <div>
      <div style={sectionHeaderStyle}>Verb</div>
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
        return (
          <label
            key={op}
            title={locked ? lockedReason : undefined}
            style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: locked ? 'var(--ink4)' : 'var(--ink)', marginBottom: 6, cursor: locked ? 'not-allowed' : 'pointer' }}
          >
            <input type="radio" name="operation" disabled={locked} checked={config.operation === op} onChange={() => onChange({ ...config, operation: op })} />
            {op}
            {locked && <span style={lockedBadgeStyle}>Locked</span>}
          </label>
        );
      })}

      <div style={{ marginTop: 16 }}>
        <div style={sectionHeaderStyle}>Table</div>
        {entities.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--ink4)' }}>
            {connectionId ? 'Loading tables…' : 'Select a connection first.'}
          </div>
        ) : (
          <select
            value={selectedKey}
            onChange={(e) => onChange({ ...config, entity: e.target.value ? parseEntityKey(e.target.value) : undefined })}
            style={{ width: '100%', height: 28, borderRadius: 6, border: '1px solid var(--line2)', padding: '0 8px', fontSize: 12.5, boxSizing: 'border-box', color: 'var(--ink)', background: 'var(--surface)' }}
          >
            <option value="">{nodeType === 'source' ? 'Infer from mapping…' : 'Select a table…'}</option>
            {entities.map((e) => (
              <option key={entityKey(e)} value={entityKey(e)}>
                {e.namespace ? `${e.namespace}.${e.name}` : e.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {nodeType === 'destination' && connectionId && namespace !== undefined && !grantCovers && (
        <GrantAccessPanel connectionId={connectionId} connectorId={manifestId} namespace={namespace} pendingGrant={pendingGrant} />
      )}
      {nodeType === 'destination' && connectionId && namespace !== undefined && grantCovers && activeGrant && (
        <RevokeAccessPanel connectionId={connectionId} grant={activeGrant} namespace={namespace} />
      )}
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
  upstreamSource?: { connectionId?: string; manifestId?: string };
  /** Latest persisted check-run results, forwarded to MappingEditor to gate Preview. See MappingEditor.tsx's prop comment. */
  checkResults?: CheckResult[] | null;
  onConfigChange: (config: Record<string, unknown>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { data } = node;
  const manifest = data.manifestId ? CONNECTOR_MANIFESTS[data.manifestId] : undefined;
  const parsed = parseNodeConfig(data.graphNodeType, data.config);

  return (
    <div style={drawerStyle} data-testid="node-drawer">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }}>
          {data.resolved ? (data.manifestName ?? 'Unconfigured') : (data.unknownReason ?? 'Unknown')}
        </span>
        <button type="button" aria-label="Close" onClick={onClose} style={{ border: 'none', background: 'none', color: 'var(--ink4)', cursor: 'pointer', fontSize: 14, padding: 0 }}>
          {'\u2715'}
        </button>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--ink4)', marginBottom: 16 }}>
        {data.graphNodeType}
        {data.connectionLabel ? ` · ${data.connectionLabel}` : ''}
      </div>

      {!data.resolved && (
        <div style={{ fontSize: 12.5, color: 'var(--ink3)', marginBottom: 16 }}>
          This node references a tool or connection that no longer exists. It can only be removed.
        </div>
      )}

      {data.resolved && data.graphNodeType !== 'transform' && !parsed.unrecognized && (
        <SourceDestForm
          config={parsed.value as SourceDestConfig}
          operations={manifest?.operations ?? ['read']}
          nodeType={data.graphNodeType === 'destination' ? 'destination' : 'source'}
          connectionId={data.connectionId}
          manifestId={data.manifestId}
          onChange={(next) => onConfigChange(next)}
        />
      )}

      {data.resolved && data.graphNodeType === 'destination' && !parsed.unrecognized && (
        <div style={{ borderTop: '1px solid var(--line2)', marginTop: 16, paddingTop: 16 }}>
          <MappingEditor
            config={parsed.value as SourceDestConfig}
            workflowId={workflowId}
            destNodeId={node.id}
            destConnectionId={data.connectionId}
            sourceConnectionId={upstreamSource?.connectionId}
            checkResults={checkResults}
            onChange={(next) => onConfigChange(next)}
          />
        </div>
      )}

      {data.resolved && data.graphNodeType === 'transform' && !parsed.unrecognized && (
        <TransformEditor
          config={parsed.value as TransformConfig}
          connectionId={upstreamSource?.connectionId}
          manifestId={upstreamSource?.manifestId}
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

      <div style={{ borderTop: '1px solid var(--line2)', marginTop: 20, paddingTop: 12 }}>
        <button
          type="button"
          onClick={onDelete}
          style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--bad)', background: 'var(--bad-bg)', border: '1px solid var(--bad-bd)', borderRadius: 6, padding: '6px 12px', cursor: 'pointer' }}
        >
          Delete node
        </button>
      </div>
    </div>
  );
}
