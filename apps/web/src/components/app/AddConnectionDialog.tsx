'use client';

import { useActionState, useEffect } from 'react';
import type { ConfigField } from '@nia/schemas';
import { createConnectionAction } from '@/lib/connections/actions';
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

  useEffect(() => {
    if (state?.success) onClose();
  }, [state, onClose]);

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

          {configSchema.map((field) => (
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
                style={modalFieldStyle(false)}
              />
            </div>
          ))}

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
