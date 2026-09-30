'use client';

import { useActionState, useEffect } from 'react';
import type { ActionState } from '@/lib/auth/actions';
import {
  nxModalBodyStyle,
  nxModalCancelCellStyle,
  nxModalCardStyle,
  nxModalErrorStyle,
  nxModalFieldRowStyle,
  nxModalFieldStyle,
  nxModalFooterStyle,
  nxModalLabelStyle,
  nxModalOverlayStyle,
  nxModalPrimaryCellStyle,
  nxModalTitleRowStyle,
  nxModalTitleStyle,
} from './styles';

const initialState: ActionState = null;

// Generic rename dialog shared by projects and workflows — same nxModal
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
    <div style={nxModalOverlayStyle} onClick={onClose}>
      <div style={nxModalCardStyle} onClick={(e) => e.stopPropagation()}>
        <form action={formAction} style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={nxModalBodyStyle}>
            <div style={nxModalTitleRowStyle}>
              <span style={nxModalTitleStyle}>{title}</span>
            </div>
            <div style={nxModalFieldRowStyle}>
              <label htmlFor="rename-name" style={nxModalLabelStyle}>{label}</label>
              <input
                id="rename-name"
                name="name"
                type="text"
                autoFocus
                defaultValue={initialName}
                className="nx-modal-field"
                style={nxModalFieldStyle(Boolean(state?.fieldErrors?.name))}
              />
              {state?.fieldErrors?.name && <span style={nxModalErrorStyle}>{state.fieldErrors.name[0]}</span>}
              {state?.error && <span style={nxModalErrorStyle}>{state.error}</span>}
            </div>
          </div>
          <div style={nxModalFooterStyle}>
            <button type="button" style={nxModalCancelCellStyle} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={pending} style={nxModalPrimaryCellStyle(pending)}>
              {pending && <span className="nx-spinner" aria-hidden style={{ color: 'var(--nx-blue-panel)' }} />}
              {pending ? 'Saving\u2026' : 'Save'}
              {!pending && (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" aria-hidden>
                  <path d="M2.5 8h11M9 3.5 13.5 8 9 12.5" />
                </svg>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
