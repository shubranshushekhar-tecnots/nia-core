'use client';

import { useActionState, useEffect, type CSSProperties } from 'react';
import type { ActionState } from '@/lib/auth/actions';
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

const initialState: ActionState = null;

/**
 * Slice L3 — same shared delete-confirm dialog shape as
 * DeleteConfirmDialog.tsx/NxConnectionsDeleteDialog.tsx (identical
 * props/action/effect behavior), copied with the tag/button text changed to
 * "Revoke" — mirrors the precedent those two already set (Connections'
 * variant changes the tag to "Remove", keeping the shared component
 * untouched since it's reused elsewhere).
 */
export default function RevokeAgentDialog({
  title,
  message,
  hiddenFields,
  action,
  onClose,
  onSuccess,
}: {
  title: string;
  message: string;
  hiddenFields: Record<string, string>;
  action: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
  onClose: () => void;
  onSuccess?: () => void;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);

  useEffect(() => {
    if (state?.success) {
      // Refresh the list immediately rather than waiting for the next
      // ~15s poll (AgentsClient.tsx) so a revoke is reflected right away.
      onSuccess?.();
      onClose();
    }
  }, [state, onClose, onSuccess]);

  return (
    <div style={nxModalOverlayStyle} onClick={onClose}>
      <div style={nxModalCardStyle} onClick={(e) => e.stopPropagation()}>
        <form action={formAction} style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={nxModalBodyStyle}>
            <span style={nxModalDestructiveTagStyle}>Revoke</span>
            <span style={nxModalTitleStyle}>{title}</span>
            <p style={{ ...nxModalBodyTextStyle, margin: 0 }}>{message}</p>
            {Object.entries(hiddenFields).map(([key, value]) => (
              <input key={key} type="hidden" name={key} value={value} />
            ))}
            {state?.error && <span style={nxModalErrorStyle}>{state.error}</span>}
          </div>
          <div style={nxModalFooterStyle}>
            <button type="button" style={nxModalCancelCellStyle} onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending}
              className="nx-wipe"
              style={{ ...nxModalDangerCellStyle(pending), '--wipe-fill': 'var(--nx-danger)', '--wipe-on': 'var(--nx-bg)' } as CSSProperties}
            >
              {pending ? 'Revoking\u2026' : 'Revoke'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
