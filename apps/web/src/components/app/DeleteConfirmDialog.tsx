'use client';

import { useActionState, useEffect } from 'react';
import type { ActionState } from '@/lib/auth/actions';
import {
  modalActionsStyle,
  modalBtnDangerStyle,
  modalBtnGhostStyle,
  modalCardStyle,
  modalErrorStyle,
  modalOverlayStyle,
  modalTitleStyle,
} from './styles';

const initialState: ActionState = null;

// Generic delete-confirm dialog shared by projects, workflows, and
// connections. Projects/workflows' bound actions redirect on success
// (throw NEXT_REDIRECT), which unmounts this dialog on its own — the
// effect below never fires for them. Connections' delete action instead
// returns `{success: true}` (there's nowhere to redirect to), so the
// effect closes the dialog explicitly in that case. On failure (RLS
// mismatch, etc.), `state.error` renders inline instead of doing nothing.
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
    <div style={modalOverlayStyle} onClick={onClose}>
      <div style={modalCardStyle} onClick={(e) => e.stopPropagation()}>
        <span style={modalTitleStyle}>{title}</span>
        <p style={{ fontSize: 13.5, color: 'var(--text-3)', margin: 0 }}>{message}</p>
        <form action={formAction} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {Object.entries(hiddenFields).map(([key, value]) => (
            <input key={key} type="hidden" name={key} value={value} />
          ))}
          {state?.error && <span style={modalErrorStyle}>{state.error}</span>}
          <div style={modalActionsStyle}>
            <button type="button" style={modalBtnGhostStyle} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={pending} style={modalBtnDangerStyle}>
              {pending ? 'Deleting\u2026' : 'Delete'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
