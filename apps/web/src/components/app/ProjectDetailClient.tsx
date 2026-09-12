'use client';

import { useState } from 'react';
import Link from 'next/link';
import { deleteProject, renameProject } from '@/lib/dashboard/actions';
import type { ProjectDetail, SidebarProject } from '@/lib/dashboard/types';
import {
  dropdownItemStyle,
  dropdownStyle,
  kebabBtnStyle,
  pageCrumbCurrentStyle,
  pageCrumbLinkStyle,
  pageCrumbRowStyle,
  pageCrumbSepStyle,
  pageHeaderRowStyle,
  primaryBtnStyle,
  projectHeaderRowStyle,
  projectMetaStyle,
  projectTitleColStyle,
  projectTitleStyle,
  statusDotStyle,
  workflowListMetaStyle,
  workflowListNameStyle,
  workflowListRowStyle,
  workflowListStatusStyle,
} from './styles';
import CreateWorkflowDialog from './CreateWorkflowDialog';
import RenameDialog from './RenameDialog';
import DeleteConfirmDialog from './DeleteConfirmDialog';

// Breadcrumb is page-level only — "Projects / <project name>" — since the
// app-shell TopBar already renders "Nia Core / <workspace>" above this;
// repeating that here was the duplicated-breadcrumb bug. Ported from the
// design's `isProject` section (designs/Nia Core App.html): a `Projects`
// link in --text-3, a --text-4 separator, and the current name in --text-2.
export default function ProjectDetailClient({
  orgId,
  orgName,
  project,
  projects,
}: {
  orgId: string | null;
  orgName: string | null;
  project: ProjectDetail;
  projects: SidebarProject[];
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [showCreateWorkflow, setShowCreateWorkflow] = useState(false);

  const workflowCount = project.workflows.length;
  const metaText = workflowCount === 0 ? 'No workflows yet' : `${workflowCount} workflow${workflowCount === 1 ? '' : 's'}`;

  return (
    <>
      <div style={pageHeaderRowStyle}>
        <div style={pageCrumbRowStyle}>
          <Link href="/app/projects" style={pageCrumbLinkStyle}>
            Projects
          </Link>
          <span style={pageCrumbSepStyle}>/</span>
          <span style={pageCrumbCurrentStyle}>{project.name}</span>
        </div>

        <div style={projectHeaderRowStyle}>
          <div style={projectTitleColStyle}>
            <span style={projectTitleStyle}>{project.name}</span>
            <span style={projectMetaStyle}>{metaText}</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button type="button" style={primaryBtnStyle} onClick={() => setShowCreateWorkflow(true)}>
              New workflow
            </button>
            <div style={{ position: 'relative' }}>
              <button type="button" style={kebabBtnStyle} onClick={() => setMenuOpen((v) => !v)} aria-label="Project actions">
                {'\u22EF'}
              </button>
              {menuOpen && (
                <div style={{ ...dropdownStyle, right: 0, left: 'auto', minWidth: 176 }} onMouseLeave={() => setMenuOpen(false)}>
                  <button
                    type="button"
                    style={dropdownItemStyle}
                    onClick={() => {
                      setMenuOpen(false);
                      setShowRename(true);
                    }}
                  >
                    Rename project
                  </button>
                  <button
                    type="button"
                    style={{ ...dropdownItemStyle, color: 'var(--bad)' }}
                    onClick={() => {
                      setMenuOpen(false);
                      setShowDelete(true);
                    }}
                  >
                    Delete project
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div>
        {project.workflows.length === 0 && (
          <p style={{ fontSize: 13.5, color: 'var(--text-3)' }}>No workflows yet in this project.</p>
        )}
        {project.workflows.map((workflow) => (
          <Link key={workflow.id} href={`/app/workflows/${workflow.id}`} style={workflowListRowStyle}>
            <span style={statusDotStyle(workflow.status)} aria-hidden />
            <span style={workflowListNameStyle}>{workflow.name}</span>
            <span style={workflowListStatusStyle}>{workflow.status}</span>
            <span style={workflowListMetaStyle}>{new Date(workflow.updatedAt).toLocaleDateString()}</span>
          </Link>
        ))}
      </div>

      {showRename && (
        <RenameDialog
          title="Rename project"
          label="Project name"
          initialName={project.name}
          action={renameProject.bind(null, project.id)}
          onClose={() => setShowRename(false)}
        />
      )}

      {showDelete && (
        <DeleteConfirmDialog
          title="Delete project?"
          message={`This also deletes its ${project.workflows.length} workflow${project.workflows.length === 1 ? '' : 's'}. This can't be undone.`}
          hiddenFields={{ projectId: project.id }}
          action={deleteProject}
          onClose={() => setShowDelete(false)}
        />
      )}

      {showCreateWorkflow && (
        <CreateWorkflowDialog
          orgId={orgId}
          projects={projects}
          defaultProjectId={project.id}
          onClose={() => setShowCreateWorkflow(false)}
        />
      )}
    </>
  );
}
