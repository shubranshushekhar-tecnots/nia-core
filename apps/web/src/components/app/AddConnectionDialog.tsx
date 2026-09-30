'use client';

import { useActionState, useEffect, type CSSProperties } from 'react';
import type { ConfigField } from '@nia/schemas';
import { createConnectionAction } from '@/lib/connections/actions';
import { useModalA11y } from '@/lib/a11y/useModalDialog';
import type { ActionState } from '@/lib/auth/actions';
import ConnectionForm from './ConnectionForm';
import { nxModalBodyStyle, nxModalCancelCellStyle, nxModalCardStyle, nxModalFooterStyle, nxModalOverlayStyle, nxModalPrimaryCellStyle } from './styles';

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
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);

  useEffect(() => {
    if (state?.success) onClose();
  }, [state, onClose]);

  return (
    <div style={nxModalOverlayStyle} onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Add ${connectorName} connection`}
        tabIndex={-1}
        style={{ ...nxModalCardStyle, outline: 'none' }}
        onClick={(e) => e.stopPropagation()}
      >
        <form action={formAction} style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ ...nxModalBodyStyle, maxHeight: '70vh', overflowY: 'auto' }}>
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
          </div>
          <div style={nxModalFooterStyle}>
            <button type="button" style={nxModalCancelCellStyle} onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending}
              className="nx-wipe"
              style={{ ...nxModalPrimaryCellStyle(pending), '--wipe-fill': 'var(--nx-ink)', '--wipe-on': 'var(--nx-bg)' } as CSSProperties}
            >
              {pending ? 'Adding\u2026' : 'Add connection'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
