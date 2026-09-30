'use client';

import { useActionState, useEffect } from 'react';
import { createWorkflow } from '@/lib/dashboard/actions';
import type { ActionState } from '@/lib/auth/actions';
import type { SidebarProject } from '@/lib/dashboard/types';
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

  const noProjects = projects.length === 0;

  return (
    <div style={nxModalOverlayStyle} onClick={onClose}>
      <div style={nxModalCardStyle} onClick={(e) => e.stopPropagation()}>
        <form action={noProjects ? undefined : formAction} style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={nxModalBodyStyle}>
            <span style={nxModalTagStyle}>New</span>
            <span style={nxModalTitleStyle}>New workflow</span>
            {noProjects ? (
              <p style={{ fontSize: 13, color: 'var(--nx-ink-2)', margin: 0 }}>
                Create a project first {'\u2014'} workflows live inside one.
              </p>
            ) : (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label htmlFor="workflow-project" style={nxModalLabelStyle}>Project</label>
                  <select
                    id="workflow-project"
                    name="projectId"
                    defaultValue={defaultProjectId ?? projects[0]?.id}
                    style={nxModalFieldStyle(Boolean(state?.fieldErrors?.projectId))}
                  >
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                  {state?.fieldErrors?.projectId && (
                    <span style={nxModalErrorStyle}>{state.fieldErrors.projectId[0]}</span>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label htmlFor="workflow-name" style={nxModalLabelStyle}>Name</label>
                  <input
                    id="workflow-name"
                    name="name"
                    type="text"
                    autoFocus
                    placeholder="Daily revenue sync"
                    style={nxModalFieldStyle(Boolean(state?.fieldErrors?.name))}
                  />
                  {state?.fieldErrors?.name && <span style={nxModalErrorStyle}>{state.fieldErrors.name[0]}</span>}
                </div>
                {state?.error && <span style={nxModalErrorStyle}>{state.error}</span>}
              </>
            )}
          </div>
          <div style={nxModalFooterStyle}>
            <button type="button" style={nxModalCancelCellStyle} onClick={onClose}>
              Cancel
            </button>
            {!noProjects && (
              <button type="submit" disabled={pending} style={nxModalPrimaryCellStyle(pending)}>
                {pending ? 'Creating\u2026' : 'Create workflow'}
                {!pending && (
                  <span aria-hidden style={{ fontSize: 14 }}>
                    {'\u2192'}
                  </span>
                )}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
