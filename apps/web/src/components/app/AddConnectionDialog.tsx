'use client';

import { useActionState, useEffect, useRef } from 'react';
import type { ConfigField } from '@nia/schemas';
import { createConnectionAction } from '@/lib/connections/actions';
import { autoCompleteFor } from '@/lib/connections/formFields';
import type { ActionState } from '@/lib/auth/actions';
import {
  modalActionsStyle,
  modalBtnGhostStyle,
  modalBtnPrimaryStyle,
  modalCardStyle,
  modalErrorStyle,
  modalFieldStyle,
  modalLabelStyle,
  modalOverlayStyle,
  modalTitleStyle,
} from './styles';

const initialState: ActionState = null;

// Generic structural check, not tied to a specific connectorId — any manifest
// shaped like a plain Postgres/MySQL credential form (host/port/database/
// user/password) gets the paste-a-URL convenience for free.
const URL_PASTE_KEYS = ['host', 'port', 'database', 'user', 'password'] as const;

function inputType(field: ConfigField): string {
  if (field.type === 'password') return 'password';
  if (field.type === 'number') return 'number';
  return 'text';
}

export default function AddConnectionDialog({
  connectorName,
  connectorId,
  configSchema,
  onClose,
}: {
  connectorName: string;
  connectorId: string;
  configSchema: ConfigField[];
  onClose: () => void;
}) {
  const [state, formAction, pending] = useActionState(createConnectionAction.bind(null, connectorId), initialState);
  const fieldRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const showUrlPaste = URL_PASTE_KEYS.every((k) => configSchema.some((f) => f.key === k));

  useEffect(() => {
    if (state?.success) onClose();
  }, [state, onClose]);

  function applyPastedUrl(value: string) {
    if (!value.trim()) return;
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      return; // ignore invalid/incomplete URL while typing
    }
    const refs = fieldRefs.current;
    if (refs.host) refs.host.value = url.hostname;
    if (refs.port) refs.port.value = url.port;
    if (refs.database) refs.database.value = url.pathname.replace(/^\//, '');
    if (refs.user) refs.user.value = decodeURIComponent(url.username);
    if (refs.password) refs.password.value = decodeURIComponent(url.password);
    if (refs.ssl) {
      const sslmode = url.searchParams.get('sslmode');
      refs.ssl.checked = Boolean(sslmode) && sslmode !== 'disable';
    }
  }

  return (
    <div style={modalOverlayStyle} onClick={onClose}>
      <div style={modalCardStyle} onClick={(e) => e.stopPropagation()}>
        <span style={modalTitleStyle}>Add {connectorName} connection</span>
        <form action={formAction} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label htmlFor="connection-display-name" style={modalLabelStyle}>
              Name
            </label>
            <input
              id="connection-display-name"
              name="displayName"
              type="text"
              autoFocus
              placeholder={`My ${connectorName} connection`}
              style={modalFieldStyle(Boolean(state?.fieldErrors?.displayName))}
            />
            {state?.fieldErrors?.displayName && <span style={modalErrorStyle}>{state.fieldErrors.displayName[0]}</span>}
          </div>

          {showUrlPaste && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label htmlFor="connection-paste-url" style={modalLabelStyle}>
                Paste connection URL (optional)
              </label>
              <input
                id="connection-paste-url"
                type="text"
                placeholder="postgres://user:pass@host:5432/db?sslmode=require"
                style={modalFieldStyle(false)}
                onChange={(e) => applyPastedUrl(e.target.value)}
              />
            </div>
          )}

          {configSchema.map((field) => {
            if (field.type === 'boolean') {
              return (
                <div key={field.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    id={`connection-field-${field.key}`}
                    name={field.key}
                    type="checkbox"
                    // Boolean fields today are exactly one thing: "Use TLS"
                    // (postgres/supabase's `ssl`). Defaulting to on matches
                    // real hosted targets (Supabase, Neon, etc.) which all
                    // require TLS — an unchecked-by-default toggle just
                    // means most users silently fail their first connect.
                    defaultChecked
                    ref={(el) => {
                      fieldRefs.current[field.key] = el;
                    }}
                  />
                  <label htmlFor={`connection-field-${field.key}`} style={modalLabelStyle}>
                    {field.label}
                  </label>
                </div>
              );
            }
            return (
              <div key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label htmlFor={`connection-field-${field.key}`} style={modalLabelStyle}>
                  {field.label}
                </label>
                <input
                  id={`connection-field-${field.key}`}
                  name={field.key}
                  type={inputType(field)}
                  required={field.required}
                  placeholder={field.placeholder}
                  // The browser autofilling a *different* connection's saved
                  // credentials (e.g. the Supabase admin login) into this
                  // form is worse than useless here — every connection's
                  // username/password is target-specific and should never be
                  // suggested from another site/account's saved credentials.
                  autoComplete={autoCompleteFor(field)}
                  ref={(el) => {
                    fieldRefs.current[field.key] = el;
                  }}
                  style={modalFieldStyle(false)}
                />
              </div>
            );
          })}

          {state?.error && <span style={modalErrorStyle}>{state.error}</span>}
          <div style={modalActionsStyle}>
            <button type="button" style={modalBtnGhostStyle} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={pending} style={modalBtnPrimaryStyle}>
              {pending ? 'Adding\u2026' : 'Add connection'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
