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

// Generic delete-confirm dialog shared by projects, workflows, and
// connections. Projects/workflows' bound actions redirect on success
// (throw NEXT_REDIRECT), which unmounts this dialog on its own — the
// effect below never fires for them. Connections' delete action instead
// returns `{success: true}` (there's nowhere to redirect to), so the
// effect closes the dialog explicitly in that case. On failure (RLS
// mismatch, etc.), `state.error` renders inline instead of doing nothing.
//
// Precision Dark redesign (Step 8A item 3): migrated in place to the
// nxModal destructive pattern (same markup as NxConnectionsDeleteDialog,
// which now duplicates this exactly and could be pointed back here — left
// alone since collapsing it isn't part of this step). Props, copy and
// behavior are unchanged; only the render output differs.
export default function DeleteConfirmDialog({
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
            <span style={nxModalDestructiveTagStyle}>Delete</span>
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
