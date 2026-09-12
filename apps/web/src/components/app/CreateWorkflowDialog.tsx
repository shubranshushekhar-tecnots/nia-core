'use client';

import { useActionState, useEffect } from 'react';
import { createWorkflow } from '@/lib/dashboard/actions';
import type { ActionState } from '@/lib/auth/actions';
import type { SidebarProject } from '@/lib/dashboard/types';
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

export default function CreateWorkflowDialog({
  orgId,
  projects,
  defaultProjectId,
  onClose,
}: {
  orgId: string | null;
  projects: SidebarProject[];
  defaultProjectId?: string;
  onClose: () => void;
}) {
  const [state, formAction, pending] = useActionState(createWorkflow.bind(null, orgId), initialState);

  useEffect(() => {
    if (state?.success) onClose();
  }, [state, onClose]);

  return (
    <div style={modalOverlayStyle} onClick={onClose}>
      <div style={modalCardStyle} onClick={(e) => e.stopPropagation()}>
        <span style={modalTitleStyle}>New workflow</span>
        {projects.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-3)', margin: 0 }}>
            Create a project first {'\u2014'} workflows live inside one.
          </p>
        ) : (
          <form action={formAction} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label htmlFor="workflow-project" style={modalLabelStyle}>Project</label>
              <select
                id="workflow-project"
                name="projectId"
                defaultValue={defaultProjectId ?? projects[0]?.id}
                style={modalFieldStyle(Boolean(state?.fieldErrors?.projectId))}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
              {state?.fieldErrors?.projectId && <span style={modalErrorStyle}>{state.fieldErrors.projectId[0]}</span>}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label htmlFor="workflow-name" style={modalLabelStyle}>Name</label>
              <input
                id="workflow-name"
                name="name"
                type="text"
                autoFocus
                placeholder="Daily revenue sync"
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
                {pending ? 'Creating\u2026' : 'Create workflow'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
