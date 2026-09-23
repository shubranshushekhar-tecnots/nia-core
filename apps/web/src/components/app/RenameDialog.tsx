'use client';

import { useActionState, useEffect } from 'react';
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

// Generic rename dialog shared by projects and workflows — same modal
// primitives as CreateProjectDialog/CreateWorkflowDialog, just bound to
// whichever rename server action the caller passes in.
export default function RenameDialog({
  title,
  label,
  initialName,
  action,
  onClose,
}: {
  title: string;
  label: string;
  initialName: string;
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
        <form action={formAction} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label htmlFor="rename-name" style={modalLabelStyle}>{label}</label>
            <input
              id="rename-name"
              name="name"
              type="text"
              autoFocus
              defaultValue={initialName}
              style={modalFieldStyle(Boolean(state?.fieldErrors?.name))}
            />
            {state?.fieldErrors?.name && <span style={modalErrorStyle}>{state.fieldErrors.name[0]}</span>}
          </div>
          {state?.error && <span style={modalErrorStyle}>{state.error}</span>}
          <div style={modalActionsStyle}>
            <button type="button" style={modalBtnGhostStyle} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={pending} style={modalBtnPrimaryStyle}>
              {pending ? 'Saving\u2026' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
