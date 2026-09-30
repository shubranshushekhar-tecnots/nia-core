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
} from './styles';

const initialState: ActionState = null;

// Precision Dark redesign (Step 4, Connections). Same delete-confirm
// dialog as DeleteConfirmDialog.tsx (identical props/action/effect
// behavior — this page's uninstall action returns `{success: true}` so
// the effect below closes the dialog explicitly, it never redirects) —
// this nx variant only restyles the markup, it's Connections-only.
// DeleteConfirmDialog.tsx itself stays untouched: it's shared by
// projects/workflows/members dialogs outside this step's scope.
export default function NxConnectionsDeleteDialog({
  title,
  message,
  hiddenFields,
  action,
  onClose,
}: {
  title: string;
  message: string;
  hiddenFields: Record<string, string>;
  action: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
  onClose: () => void;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);

  useEffect(() => {
    if (state?.success) onClose();
  }, [state, onClose]);

  return (
    <div style={nxModalOverlayStyle} onClick={onClose}>
      <div style={nxModalCardStyle} onClick={(e) => e.stopPropagation()}>
        <form action={formAction} style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={nxModalBodyStyle}>
            <span style={nxModalDestructiveTagStyle}>Remove</span>
            <span style={nxModalTitleStyle}>{title}</span>
            <p style={{ ...nxModalBodyTextStyle, margin: 0 }}>{message}</p>
            {Object.entries(hiddenFields).map(([key, value]) => (
              <input key={key} type="hidden" name={key} value={value} />
            ))}
            {state?.error && (
              <span style={nxModalErrorStyle}>
                {state.error}
                {state.errorFix && <span style={{ display: 'block', marginTop: 2 }}>{state.errorFix}</span>}
                {state.errorDetails && state.errorDetails !== state.error && (
                  <details style={{ marginTop: 4 }}>
                    <summary style={{ cursor: 'pointer' }}>Show details</summary>
                    <span style={{ display: 'block', marginTop: 2 }}>{state.errorDetails}</span>
                  </details>
                )}
              </span>
            )}
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
              {pending ? 'Deleting\u2026' : 'Delete'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
