'use client';

import { useActionState, useEffect } from 'react';
import type { ConfigField } from '@nia/schemas';
import { createConnectionAction } from '@/lib/connections/actions';
import type { ActionState } from '@/lib/auth/actions';
import ConnectionForm from './ConnectionForm';
import { modalActionsStyle, modalBtnGhostStyle, modalBtnPrimaryStyle, modalCardStyle, modalOverlayStyle } from './styles';

const initialState: ActionState = null;

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
        <form action={formAction} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <ConnectionForm
            title={`Add ${connectorName} connection`}
            connectorName={connectorName}
            connectorId={connectorId}
            configSchema={configSchema}
            idPrefix="connection"
            errors={{
              fieldErrors: state?.fieldErrors,
              message: state?.error,
              fix: state?.errorFix,
              details: state?.errorDetails,
            }}
          />
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
