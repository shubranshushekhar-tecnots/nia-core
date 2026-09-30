'use client';

import { useState } from 'react';
import { friendlyConnectionError, getConnectorManifest, type ConfigField } from '@nia/schemas';
import type { Connection } from '@/lib/connections/types';
import { updateConnection, ConnectionsApiError, type ConnectionUsage } from '@/lib/api/connectionsClient';
import { autoCompleteFor } from '@/lib/connections/formFields';
import { useModalA11y } from '@/lib/a11y/useModalDialog';
import HelpPanel from './HelpPanel';
import ConnectorLogo from './ConnectorLogo';
import {
  nxModalCancelCellStyle,
  nxModalCardStyle,
  nxModalErrorStyle,
  nxModalFieldStyle,
  nxModalFooterStyle,
  nxModalLabelStyle,
  nxModalOverlayStyle,
  nxModalPrimaryCellStyle,
  nxModalTitleStyle,
} from './styles';

const helpTriggerStyle = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  letterSpacing: '0.03em',
  color: 'var(--nx-ink)',
  background: 'var(--nx-surface)',
  border: '1px solid var(--nx-line)',
  padding: '6px 10px',
  cursor: 'pointer',
} as const;

function inputType(field: ConfigField): string {
  if (field.type === 'password') return 'password';
  if (field.type === 'number') return 'number';
  return 'text';
}

// `user` isn't ConfigField.type === 'password', but it's still a credential
// value we never want to display back to the browser — same "blank means
// unchanged" contract as password, mirroring formFields.ts's existing
// key === 'user' special-case for autocomplete.
function isSecretField(field: ConfigField): boolean {
  return field.type === 'password' || field.key === 'user';
}

type SavePayload = { displayName: string; fields: Record<string, unknown> };

function buildFieldsPatch(configSchema: ConfigField[], formData: FormData): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const field of configSchema) {
    if (isSecretField(field)) {
      const raw = formData.get(field.key);
      if (raw !== null && String(raw) !== '') fields[field.key] = String(raw);
      continue;
    }
    if (field.type === 'boolean') {
      fields[field.key] = formData.get(field.key) === 'on';
      continue;
    }
    const raw = formData.get(field.key);
    if (raw === null || raw === '') continue;
    fields[field.key] = field.type === 'number' ? Number(raw) : String(raw).trim();
  }
  return fields;
}

/**
 * Full edit flow for an existing connection — reuses AddConnectionDialog's
 * field-rendering, but non-secret fields are pre-filled from the stored
 * config and secret fields (password, user) render empty with an
 * "unchanged" placeholder (never round-trip a stored credential to the
 * browser). Saving always test-connects server-side first (updateConnection
 * refuses to persist on a failed test) and, if host/database changed for a
 * connection other nodes/workflows use, requires an explicit "Save anyway"
 * confirm after showing the usage list (mirrors DeleteConnectionDialog's
 * precheck UX for the same USAGE_WARNING_REQUIRED shape).
 */
export default function EditConnectionDialog({
  connection,
  onClose,
  onSaved,
}: {
  connection: Connection;
  onClose: () => void;
  onSaved: (updated: Connection) => void;
}) {
  const manifest = getConnectorManifest(connection.connectorId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorFix, setErrorFix] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [usageWarning, setUsageWarning] = useState<ConnectionUsage[] | null>(null);
  const [pendingSave, setPendingSave] = useState<SavePayload | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);

  if (!manifest) {
    return (
      <div style={nxModalOverlayStyle} onClick={onClose}>
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Edit connection"
          tabIndex={-1}
          style={{ ...nxModalCardStyle, outline: 'none' }}
          onClick={(e) => e.stopPropagation()}
        >
          <span style={nxModalTitleStyle}>Edit connection</span>
          <span style={nxModalErrorStyle}>No manifest for connector {connection.connectorId}.</span>
          <div style={nxModalFooterStyle}>
            <button type="button" style={nxModalCancelCellStyle} onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  const submit = async (payload: SavePayload, confirmed: boolean) => {
    setPending(true);
    setError(null);
    setErrorFix(null);
    setErrorDetails(null);
    try {
      const updated = await updateConnection(connection.id, { ...payload, confirmed });
      onSaved(updated);
    } catch (err) {
      if (err instanceof ConnectionsApiError && err.status === 409 && err.code === 'USAGE_WARNING_REQUIRED') {
        const workflows = (err.details as { workflows?: ConnectionUsage[] } | undefined)?.workflows ?? [];
        setUsageWarning(workflows);
        setPendingSave(payload);
        setPending(false);
        return;
      }
      // Item 5 (fix-chain plan): saving always test-connects server-side
      // first, so a failed save here is typically the same raw
      // connector/driver text the standalone "Test" button surfaces —
      // pattern-match it into a friendly summary, keep the raw text behind
      // "Show details".
      if (err instanceof ConnectionsApiError) {
        const { summary, fix, details } = friendlyConnectionError(err.message);
        setError(summary);
        setErrorFix(fix ?? null);
        setErrorDetails(details);
      } else {
        setError("Couldn't save the connection. Try again.");
      }
      setPending(false);
    }
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const displayName = String(formData.get('displayName') ?? '').trim();
    const fields = buildFieldsPatch(manifest.configSchema, formData);
    setUsageWarning(null);
    setPendingSave(null);
    void submit({ displayName, fields }, false);
  };

  return (
    <div style={nxModalOverlayStyle} onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Edit connection"
        tabIndex={-1}
        style={{ ...nxModalCardStyle, outline: 'none' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <ConnectorLogo id={connection.connectorId} tile={40} />
            <span style={nxModalTitleStyle}>Edit connection</span>
          </div>
          <button type="button" style={helpTriggerStyle} onClick={() => setShowHelp(true)}>
            Help with this step
          </button>
        </div>
        {showHelp && (
          <HelpPanel step="test-connection" connectorId={connection.connectorId} onClose={() => setShowHelp(false)} />
        )}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label htmlFor="edit-connection-display-name" style={nxModalLabelStyle}>
              Name
            </label>
            <input
              id="edit-connection-display-name"
              name="displayName"
              type="text"
              autoFocus
              defaultValue={connection.displayName}
              required
              className="nx-modal-field"
              style={nxModalFieldStyle(false)}
            />
          </div>

          {manifest.configSchema.map((field) => {
            if (field.type === 'boolean') {
              const current = connection.config[field.key];
              return (
                <div key={field.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    id={`edit-connection-field-${field.key}`}
                    name={field.key}
                    type="checkbox"
                    defaultChecked={current !== undefined ? Boolean(current) : true}
                  />
                  <label htmlFor={`edit-connection-field-${field.key}`} style={nxModalLabelStyle}>
                    {field.label}
                  </label>
                </div>
              );
            }
            const secret = isSecretField(field);
            return (
              <div key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label htmlFor={`edit-connection-field-${field.key}`} style={nxModalLabelStyle}>
                  {field.label}
                </label>
                <input
                  id={`edit-connection-field-${field.key}`}
                  name={field.key}
                  type={inputType(field)}
                  required={secret ? false : field.required}
                  placeholder={secret ? 'unchanged' : field.placeholder}
                  defaultValue={secret ? '' : String(connection.config[field.key] ?? '')}
                  autoComplete={autoCompleteFor(field)}
                  className="nx-modal-field"
                  style={nxModalFieldStyle(false)}
                />
              </div>
            );
          })}

          {usageWarning && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontFamily: 'var(--nx-font-mono)', fontSize: 11.5, fontWeight: 600, color: 'var(--nx-warn)' }}>
                This change affects {usageWarning.length} workflow{usageWarning.length === 1 ? '' : 's'}:
              </span>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--nx-ink-2)' }}>
                {usageWarning.map((u) => (
                  <li key={u.id}>
                    {u.name} — {u.nodeCount} node{u.nodeCount === 1 ? '' : 's'}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error && (
            <span style={nxModalErrorStyle}>
              {error}
              {errorFix && <span style={{ display: 'block', marginTop: 2 }}>{errorFix}</span>}
              {errorDetails && errorDetails !== error && (
                <details style={{ marginTop: 4 }}>
                  <summary style={{ cursor: 'pointer' }}>Show details</summary>
                  <span style={{ display: 'block', marginTop: 2 }}>{errorDetails}</span>
                </details>
              )}
            </span>
          )}

          <div style={nxModalFooterStyle}>
            <button type="button" style={nxModalCancelCellStyle} onClick={onClose} disabled={pending}>
              Cancel
            </button>
            {usageWarning ? (
              <button
                type="button"
                style={nxModalPrimaryCellStyle(pending)}
                disabled={pending}
                onClick={() => pendingSave && void submit(pendingSave, true)}
              >
                {pending ? 'Saving\u2026' : 'Save anyway'}
              </button>
            ) : (
              <button type="submit" disabled={pending} style={nxModalPrimaryCellStyle(pending)}>
                {pending ? 'Testing & saving\u2026' : 'Save'}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
