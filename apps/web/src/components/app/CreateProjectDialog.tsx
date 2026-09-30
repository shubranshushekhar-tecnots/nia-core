'use client';

import { useActionState, useEffect } from 'react';
import { createProject } from '@/lib/dashboard/actions';
import type { ActionState } from '@/lib/auth/actions';
import {
  nxModalBodyStyle,
  nxModalCancelCellStyle,
  nxModalCardStyle,
  nxModalErrorStyle,
  nxModalFieldStyle,
  nxModalFooterStyle,
  nxModalLabelStyle,
  nxModalOverlayStyle,
  nxModalPrimaryCellStyle,
  nxModalTagStyle,
  nxModalTitleStyle,
} from './styles';

const initialState: ActionState = null;

export default function CreateProjectDialog({ orgId, onClose }: { orgId: string | null; onClose: () => void }) {
  const [state, formAction, pending] = useActionState(createProject.bind(null, orgId), initialState);

  useEffect(() => {
    if (state?.success) onClose();
  }, [state, onClose]);

  return (
    <div style={nxModalOverlayStyle} onClick={onClose}>
      <div style={nxModalCardStyle} onClick={(e) => e.stopPropagation()}>
        <form action={formAction} style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={nxModalBodyStyle}>
            <span style={nxModalTagStyle}>New</span>
            <span style={nxModalTitleStyle}>New project</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label htmlFor="project-name" style={nxModalLabelStyle}>Name</label>
              <input
                id="project-name"
                name="name"
                type="text"
                autoFocus
                placeholder="Sales Analytics"
                style={nxModalFieldStyle(Boolean(state?.fieldErrors?.name))}
              />
              {state?.fieldErrors?.name && <span style={nxModalErrorStyle}>{state.fieldErrors.name[0]}</span>}
            </div>
            {state?.error && <span style={nxModalErrorStyle}>{state.error}</span>}
          </div>
          <div style={nxModalFooterStyle}>
            <button type="button" style={nxModalCancelCellStyle} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={pending} style={nxModalPrimaryCellStyle(pending)}>
              {pending ? 'Creating\u2026' : 'Create project'}
              {!pending && (
                <span aria-hidden style={{ fontSize: 14 }}>
                  {'\u2192'}
                </span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
