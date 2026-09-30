'use client';

import { useState, type CSSProperties } from 'react';
import Link from 'next/link';
import type { ActorRole } from '@nia/schemas';
import { deleteProject, renameProject } from '@/lib/dashboard/actions';
import type { ProjectDetail, SidebarProject } from '@/lib/dashboard/types';
import type { ProjectMemberProfile } from '@/lib/projectMembers/actions';
import {
  nxProjDetailBodyStyle,
  nxProjDetailBreadcrumbStyle,
  nxProjDetailColHeaderCellStyle,
  nxProjDetailColHeaderRowStyle,
  nxProjDetailDropdownItemStyle,
  nxProjDetailDropdownStyle,
  nxProjDetailEmptyBoxStyle,
  nxProjDetailEmptyTextStyle,
  nxProjDetailHeaderRowStyle,
  nxProjDetailKebabBtnStyle,
  nxProjDetailKebabColStyle,
  nxProjDetailLeftColStyle,
  nxProjDetailMembersColStyle,
  nxProjDetailMetaStyle,
  nxProjDetailNewWorkflowBtnStyle,
  nxProjDetailNewWorkflowLabelStyle,
  nxProjDetailNewWorkflowTextRowStyle,
  nxProjDetailRowArrowCellStyle,
  nxProjDetailRowDotCellStyle,
  nxProjDetailRowNameCellStyle,
  nxProjDetailRowStatusCellStyle,
  nxProjDetailRowStyle,
  nxProjDetailRowUpdatedCellStyle,
  nxProjDetailTitleStyle,
  nxProjDetailViewOnlyPanelStyle,
  nxProjDetailWorkflowsColStyle,
  nxProjViewOnlyChipStyle,
  nxWorkflowStatusDotStyle,
  nxWorkflowStatusInkColor,
} from './styles';
import CreateWorkflowDialog from './CreateWorkflowDialog';
import RenameDialog from './RenameDialog';
import DeleteConfirmDialog from './DeleteConfirmDialog';
import ProjectMembersPanel from '@/components/members/ProjectMembersPanel';

// Precision Dark redesign (Step 8B): matches ProjectDetail.dc.html /
// ProjectsStates.dc.html — 240px header (breadcrumb + hero name, a
// --nx-blue-cta "New workflow" panel, a kebab column), then a 1fr/420px
// body: a bordered "WORKFLOWS" table on the left, ProjectMembersPanel
// (reused as-is from Step 6) on the right. The "Projects / <name>"
// breadcrumb here is the board's own decorative hero-kicker label (font-
// condensed, same family as "WORKSPACE / PROJECTS" on the list page) — a
// separate element from the shared TopBar's own `crumbs` breadcrumb.
export default function ProjectDetailClient({
  orgId,
  orgName,
  project,
  projects,
  callerRole,
  callerUserId,
  projectMembers,
}: {
  orgId: string | null;
  orgName: string | null;
  project: ProjectDetail;
  projects: SidebarProject[];
  callerRole: ActorRole;
  callerUserId: string;
  projectMembers: { members: ProjectMemberProfile[]; addable: ProjectMemberProfile[] } | null;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [showCreateWorkflow, setShowCreateWorkflow] = useState(false);

  const workflowCount = project.workflows.length;
  const metaText = workflowCount === 0 ? 'No workflows yet' : `${workflowCount} workflow${workflowCount === 1 ? '' : 's'}`;
  // Subscription Phase 2, Slice 7: viewer is read-only everywhere
  // (0057_viewer_role_restrictions.sql) — hide every write trigger here.
  const canWrite = callerRole !== 'viewer';

  return (
    <>
      <div style={canWrite ? nxProjDetailHeaderRowStyle : { ...nxProjDetailHeaderRowStyle, gridTemplateColumns: 'minmax(0, 1fr) 280px' }}>
        <div style={nxProjDetailLeftColStyle}>
          <span style={nxProjDetailBreadcrumbStyle}>Projects / {project.name}</span>
          <h1 style={nxProjDetailTitleStyle}>{project.name}</h1>
          <span style={nxProjDetailMetaStyle}>{metaText}</span>
        </div>

        {canWrite ? (
          <button
            type="button"
            className="nx-wipe"
            style={{ ...nxProjDetailNewWorkflowBtnStyle, '--wipe-fill': 'var(--nx-ink)', '--wipe-on': 'var(--nx-bg)' } as CSSProperties}
            onClick={() => setShowCreateWorkflow(true)}
          >
            <span style={nxProjDetailNewWorkflowLabelStyle}>Create</span>
            <span style={nxProjDetailNewWorkflowTextRowStyle}>
              New workflow
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" aria-hidden>
                <path d="M2.5 8h11M9 3.5 13.5 8 9 12.5" />
              </svg>
            </span>
          </button>
        ) : (
          <div className="nx-halftone" style={nxProjDetailViewOnlyPanelStyle}>
            <span style={nxProjViewOnlyChipStyle}>View only</span>
          </div>
        )}

        {canWrite && (
          <div style={nxProjDetailKebabColStyle}>
            <button type="button" className="nx-wipe" style={nxProjDetailKebabBtnStyle(menuOpen)} onClick={() => setMenuOpen((v) => !v)} aria-label="Project actions">
              {'\u22EF'}
            </button>
            {menuOpen && (
              <div style={nxProjDetailDropdownStyle} onMouseLeave={() => setMenuOpen(false)}>
                <button
                  type="button"
                  style={nxProjDetailDropdownItemStyle()}
                  onClick={() => {
                    setMenuOpen(false);
                    setShowRename(true);
                  }}
                >
                  Rename project
                </button>
                <button
                  type="button"
                  style={nxProjDetailDropdownItemStyle(true)}
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
        )}
      </div>

      <div style={nxProjDetailBodyStyle}>
        <div style={nxProjDetailWorkflowsColStyle}>
          <div style={nxProjDetailColHeaderRowStyle}>
            <span style={nxProjDetailColHeaderCellStyle(0)} />
            <span style={nxProjDetailColHeaderCellStyle(4)}>Workflow</span>
            <span style={nxProjDetailColHeaderCellStyle(20)}>Status</span>
            <span style={nxProjDetailColHeaderCellStyle(20)}>Updated</span>
            <span style={nxProjDetailColHeaderCellStyle(0)} />
          </div>

          {project.workflows.length === 0 ? (
            <div style={nxProjDetailEmptyBoxStyle}>
              <p style={nxProjDetailEmptyTextStyle}>No workflows yet in this project.</p>
            </div>
          ) : (
            project.workflows.map((workflow) => (
              <Link key={workflow.id} href={`/app/workflows/${workflow.id}`} className="nx-wipe" style={nxProjDetailRowStyle}>
                <span style={nxProjDetailRowDotCellStyle}>
                  <span style={nxWorkflowStatusDotStyle(workflow.status)} aria-hidden />
                </span>
                <span style={nxProjDetailRowNameCellStyle}>{workflow.name}</span>
                <span style={{ ...nxProjDetailRowStatusCellStyle, color: nxWorkflowStatusInkColor(workflow.status) }}>{workflow.status}</span>
                <span style={nxProjDetailRowUpdatedCellStyle}>{new Date(workflow.updatedAt).toLocaleDateString()}</span>
                <span style={nxProjDetailRowArrowCellStyle}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" aria-hidden>
                    <path d="M2.5 8h11M9 3.5 13.5 8 9 12.5" />
                  </svg>
                </span>
              </Link>
            ))
          )}
        </div>

        {orgId && projectMembers && (
          <div style={nxProjDetailMembersColStyle}>
            <ProjectMembersPanel
              projectId={project.id}
              callerRole={callerRole}
              callerUserId={callerUserId}
              members={projectMembers.members}
              addable={projectMembers.addable}
            />
          </div>
        )}
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
