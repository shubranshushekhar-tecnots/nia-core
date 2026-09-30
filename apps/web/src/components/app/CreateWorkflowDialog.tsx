'use client';

import { useActionState, useEffect, type CSSProperties } from 'react';
import { createWorkflow } from '@/lib/dashboard/actions';
import type { ActionState } from '@/lib/auth/actions';
import type { SidebarProject } from '@/lib/dashboard/types';
import {
  nxModalBodyStyle,
  nxModalCancelCellStyle,
  nxModalCardStyle,
  nxModalErrorStyle,
  nxModalFieldRowStackedStyle,
  nxModalFieldRowTopStyle,
  nxModalFieldStyle,
  nxModalFooterStyle,
  nxModalLabelStyle,
  nxModalOverlayStyle,
  nxModalPrimaryCellStyle,
  nxModalTitleRowStyle,
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
            <div style={nxModalTitleRowStyle}>
              <span style={nxModalTitleStyle}>New workflow</span>
            </div>
            {noProjects ? (
              <div
                style={{
                  display: 'flex',
                  gap: 14,
                  padding: '24px 20px',
                  borderBottom: '1px solid var(--nx-line)',
                  background: 'var(--nx-surface)',
                }}
              >
                <span
                  aria-hidden
                  style={{ width: 32, height: 32, flexShrink: 0, border: '1px dashed var(--nx-ink-disabled)', boxSizing: 'border-box' }}
                />
                <p style={{ margin: 0, fontSize: 16, lineHeight: '24px', color: 'var(--nx-ink)' }}>
                  Create a project first {'\u2014'} workflows live inside one.
                </p>
              </div>
            ) : (
              <>
                <div style={nxModalFieldRowTopStyle}>
                  <label htmlFor="workflow-project" style={nxModalLabelStyle}>Project</label>
                  <select
                    id="workflow-project"
                    name="projectId"
                    defaultValue={defaultProjectId ?? projects[0]?.id}
                    className="nx-modal-field"
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
                <div style={nxModalFieldRowStackedStyle}>
                  <label htmlFor="workflow-name" style={nxModalLabelStyle}>Name</label>
                  <input
                    id="workflow-name"
                    name="name"
                    type="text"
                    autoFocus
                    placeholder="Daily revenue sync"
                    className="nx-modal-field"
                    style={nxModalFieldStyle(Boolean(state?.fieldErrors?.name))}
                  />
                  {state?.fieldErrors?.name && <span style={nxModalErrorStyle}>{state.fieldErrors.name[0]}</span>}
                  {state?.error && <span style={nxModalErrorStyle}>{state.error}</span>}
                </div>
              </>
            )}
          </div>
          <div style={nxModalFooterStyle}>
            <button type="button" style={nxModalCancelCellStyle} onClick={onClose}>
              Cancel
            </button>
            {!noProjects && (
              <button
                type="submit"
                disabled={pending}
                className="nx-wipe"
                style={{ ...nxModalPrimaryCellStyle(pending), '--wipe-fill': 'var(--nx-ink)', '--wipe-on': 'var(--nx-bg)' } as CSSProperties}
              >
                {pending && <span className="nx-spinner" aria-hidden style={{ color: 'var(--nx-blue-panel)' }} />}
                {pending ? 'Creating\u2026' : 'Create workflow'}
                {!pending && (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" aria-hidden>
                    <path d="M2.5 8h11M9 3.5 13.5 8 9 12.5" />
                  </svg>
                )}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
