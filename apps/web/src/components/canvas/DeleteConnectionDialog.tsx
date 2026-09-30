'use client';

import { useEffect, useState } from 'react';
import {
  deleteConnection,
  getConnectionUsages,
  getWriteGrants,
  ConnectionsApiError,
  type ConnectionUsage,
  type WriteGrant,
} from '@/lib/api/connectionsClient';
import { buildDropRoleStatementText } from '@nia/schemas';
import {
  nxModalBodyStyle,
  nxModalBodyTextStyle,
  nxModalCancelCellStyle,
  nxModalCardStyle,
  nxModalDangerCellStyle,
  nxModalDestructiveTagStyle,
  nxModalErrorStyle,
  nxModalFooterStyle,
  nxModalOverlayStyle,
  nxModalTitleStyle,
} from '@/components/app/styles';

/**
 * Canvas context-menu's "Delete connection…" confirm step. Distinct from
 * app/DeleteConfirmDialog (which is a generic server-action-bound dialog) —
 * this one needs a structured pre-check (getConnectionUsages) to list
 * affected workflows/CleanPlans before the destructive call, and calls the
 * browser-client deleteConnection directly rather than a Server Action, so
 * FlowCanvas can remap the canvas immediately on success instead of relying
 * on a revalidatePath that wouldn't touch this already-mounted route.
 *
 * Phase 6 follow-up: also lists any confirmed-and-not-yet-revoked write
 * grants on this connection and their `DROP ROLE`/`DROP USER` statement
 * (via `write_grants.write_role_name`, 0028) — deleting the connection row
 * never touches the actual DB role Nia never created for the user, so this
 * is the last chance to hand them the cleanup SQL for that role.
 * `connectorId` is optional (older canvas call sites may not have it handy)
 * — the grants section simply degrades to showing just the role names.
 */
export default function DeleteConnectionDialog({
  connectionId,
  connectionLabel,
  connectorId,
  onClose,
  onDeleted,
}: {
  connectionId: string;
  connectionLabel: string;
  connectorId?: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [usages, setUsages] = useState<ConnectionUsage[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [writeGrants, setWriteGrants] = useState<WriteGrant[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getConnectionUsages(connectionId)
      .then((res) => {
        if (!cancelled) setUsages(res.workflows);
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err instanceof ConnectionsApiError ? err.message : "Couldn't check where this connection is used.");
          setUsages([]);
        }
      });
    getWriteGrants(connectionId)
      .then((grants) => {
        if (!cancelled) setWriteGrants(grants.filter((g) => g.confirmedAt && !g.revokedAt));
      })
      .catch(() => {
        // Best-effort only — never block the delete flow on this.
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteConnection(connectionId, true);
      onDeleted();
    } catch (err) {
      setDeleteError(err instanceof ConnectionsApiError ? err.message : "Couldn't delete the connection. Try again.");
      setDeleting(false);
    }
  };

  const inUse = (usages?.length ?? 0) > 0;

  return (
    <div style={nxModalOverlayStyle} onClick={onClose}>
      <div style={nxModalCardStyle} onClick={(e) => e.stopPropagation()}>
        <div style={nxModalBodyStyle}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 20 }}>
            <span style={nxModalDestructiveTagStyle}>Delete</span>
            <span style={nxModalTitleStyle}>Delete connection?</span>
            <p style={{ ...nxModalBodyTextStyle, margin: 0 }}>
              This removes {connectionLabel} and its stored credential. This can{"'"}t be undone.
            </p>

            {usages === null && !loadError && (
              <span style={{ fontSize: 12.5, color: 'var(--nx-ink-3)' }}>Checking where this connection is used…</span>
            )}
            {loadError && <span style={nxModalErrorStyle}>{loadError}</span>}
            {inUse && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--nx-warn)' }}>
                  Used by {usages!.length} workflow{usages!.length === 1 ? '' : 's'}:
                </span>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--nx-ink-3)' }}>
                  {usages!.map((u) => (
                    <li key={u.id}>
                      {u.name} — {u.nodeCount} node{u.nodeCount === 1 ? '' : 's'}
                      {u.cleanPlanCount > 0 ? `, ${u.cleanPlanCount} clean plan${u.cleanPlanCount === 1 ? '' : 's'}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {writeGrants.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--nx-warn)' }}>
                  This connection has {writeGrants.length} confirmed write grant{writeGrants.length === 1 ? '' : 's'}. Deleting
                  it does not remove the database role{writeGrants.length === 1 ? '' : 's'} you created — run this to clean up:
                </span>
                <pre
                  style={{
                    fontFamily: 'var(--nx-font-mono)',
                    fontSize: 11,
                    background: 'var(--nx-surface)',
                    border: '1px solid var(--nx-line)',
                    borderRadius: 6,
                    padding: 8,
                    whiteSpace: 'pre-wrap',
                    overflowX: 'auto',
                    margin: 0,
                  }}
                >
                  {writeGrants
                    .map((g) =>
                      g.writeRoleName
                        ? (connectorId && buildDropRoleStatementText(connectorId, g.writeRoleName)) ?? `-- role: ${g.writeRoleName}`
                        : '-- role name unavailable for this grant',
                    )
                    .join('\n')}
                </pre>
              </div>
            )}

            {deleteError && <span style={nxModalErrorStyle}>{deleteError}</span>}
          </div>
        </div>

        <div style={nxModalFooterStyle}>
          <button type="button" style={nxModalCancelCellStyle} onClick={onClose} disabled={deleting}>
            Cancel
          </button>
          <button
            type="button"
            style={nxModalDangerCellStyle(deleting)}
            onClick={handleDelete}
            disabled={deleting || usages === null}
          >
            {deleting ? 'Deleting…' : inUse ? 'Delete anyway' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
