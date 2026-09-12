'use client';

import { useActionState, useEffect } from 'react';
import { createProject } from '@/lib/dashboard/actions';
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

export default function CreateProjectDialog({ orgId, onClose }: { orgId: string | null; onClose: () => void }) {
  const [state, formAction, pending] = useActionState(createProject.bind(null, orgId), initialState);

  useEffect(() => {
    if (state?.success) onClose();
  }, [state, onClose]);

  return (
    <div style={modalOverlayStyle} onClick={onClose}>
      <div style={modalCardStyle} onClick={(e) => e.stopPropagation()}>
        <span style={modalTitleStyle}>New project</span>
        <form action={formAction} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label htmlFor="project-name" style={modalLabelStyle}>Name</label>
            <input
              id="project-name"
              name="name"
              type="text"
              autoFocus
              placeholder="Sales Analytics"
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
              {pending ? 'Creating\u2026' : 'Create project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
