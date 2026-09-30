'use client';

import { useActionState, useEffect, type CSSProperties } from 'react';
import { createProject } from '@/lib/dashboard/actions';
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
            <div style={nxModalTitleRowStyle}>
              <span style={nxModalTitleStyle}>New project</span>
            </div>
            <div style={nxModalFieldRowStyle}>
              <label htmlFor="project-name" style={nxModalLabelStyle}>Name</label>
              <input
                id="project-name"
                name="name"
                type="text"
                autoFocus
                placeholder="Sales Analytics"
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
            <button
              type="submit"
              disabled={pending}
              className="nx-wipe"
              style={{ ...nxModalPrimaryCellStyle(pending), '--wipe-fill': 'var(--nx-ink)', '--wipe-on': 'var(--nx-bg)' } as CSSProperties}
            >
              {pending && <span className="nx-spinner" aria-hidden style={{ color: 'var(--nx-blue-panel)' }} />}
              {pending ? 'Creating\u2026' : 'Create project'}
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
