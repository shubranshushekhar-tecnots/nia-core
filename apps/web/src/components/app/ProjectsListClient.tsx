'use client';

import { useState, type MouseEvent } from 'react';
import Link from 'next/link';
import type { ActorRole } from '@nia/schemas';
import { deleteProject } from '@/lib/dashboard/actions';
import type { ProjectListItem } from '@/lib/dashboard/types';
import { relativeTime } from '@/lib/time';
import {
  nxProjColHeaderCellStyle,
  nxProjColHeaderRowStyle,
  nxProjCounterCellStyle,
  nxProjCounterColStyle,
  nxProjCounterCtaStyle,
  nxProjCounterLabelStyle,
  nxProjCounterRowStyle,
  nxProjCounterValueStyle,
  nxProjEmptyBoxStyle,
  nxProjEmptyCtaStyle,
  nxProjEmptyHeadingStyle,
  nxProjEmptySublineStyle,
  nxProjHeaderLeftColStyle,
  nxProjPageHeaderRowStyle,
  nxProjPageTagStyle,
  nxProjPageTitleStyle,
  nxProjRowActivityCellStyle,
  nxProjRowActivityDotStyle,
  nxProjRowArrowCellStyle,
  nxProjRowDeleteCellStyle,
  nxProjRowIndexCellStyle,
  nxProjRowNameCellStyle,
  nxProjRowNameStyle,
  nxProjRowStyle,
  nxProjRowWorkflowsCellStyle,
  nxProjSectionHeaderStyle,
  nxProjSectionMetaStyle,
  nxProjSectionTitleStyle,
  nxProjViewOnlyChipStyle,
  nxProjViewOnlyStripStyle,
} from './styles';
import CreateProjectDialog from './CreateProjectDialog';
import DeleteConfirmDialog from './DeleteConfirmDialog';

// Precision Dark redesign (Step 8B): matches Projects.dc.html /
// ProjectsStates.dc.html — 240px header (hero title + --nx-blue-panel
// PROJECTS/WORKFLOWS counter column + "New project" CTA strip), then a
// bordered "ALL PROJECTS" table (index/name/workflows/last-activity/
// delete/arrow columns). Both counters are computed client-side from the
// already-loaded list — ProjectListItem carries workflowCount per row, so
// no server change was needed to show both.
export default function ProjectsListClient({
  orgId,
  projects,
  role,
}: {
  orgId: string | null;
  projects: ProjectListItem[];
  role: ActorRole;
}) {
  // Subscription Phase 2, Slice 7: viewer is read-only everywhere
  // (0057_viewer_role_restrictions.sql) — hide every write trigger here.
  const canWrite = role !== 'viewer';
  const [showCreate, setShowCreate] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProjectListItem | null>(null);

  function onDeleteClick(e: MouseEvent, project: ProjectListItem) {
    e.preventDefault();
    e.stopPropagation();
    setDeleteTarget(project);
  }

  const projectCount = projects.length;
  const workflowCount = projects.reduce((sum, p) => sum + p.workflowCount, 0);

  return (
    <>
      <div style={nxProjPageHeaderRowStyle}>
        <div style={nxProjHeaderLeftColStyle}>
          <span style={nxProjPageTagStyle}>Workspace / Projects</span>
          <h1 style={nxProjPageTitleStyle}>Projects</h1>
        </div>
        <div style={nxProjCounterColStyle}>
          <div style={nxProjCounterRowStyle}>
            <div style={nxProjCounterCellStyle(false)}>
              <span style={nxProjCounterLabelStyle}>Projects</span>
              <span style={nxProjCounterValueStyle}>{String(projectCount).padStart(2, '0')}</span>
            </div>
            <div style={nxProjCounterCellStyle(true)}>
              <span style={nxProjCounterLabelStyle}>Workflows</span>
              <span style={nxProjCounterValueStyle}>{String(workflowCount).padStart(2, '0')}</span>
            </div>
          </div>
          {canWrite ? (
            <button type="button" className="nx-wipe" style={nxProjCounterCtaStyle} onClick={() => setShowCreate(true)}>
              New project
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" aria-hidden>
                <path d="M2.5 8h11M9 3.5 13.5 8 9 12.5" />
              </svg>
            </button>
          ) : (
            <div className="nx-halftone" style={nxProjViewOnlyStripStyle}>
              <span style={nxProjViewOnlyChipStyle}>View only</span>
            </div>
          )}
        </div>
      </div>

      <div style={nxProjSectionHeaderStyle}>
        <h2 style={nxProjSectionTitleStyle}>All projects</h2>
        <span style={nxProjSectionMetaStyle}>{projectCount} project{projectCount === 1 ? '' : 's'}</span>
      </div>

      {projects.length === 0 ? (
        <div className="nx-halftone" style={nxProjEmptyBoxStyle}>
          <h3 style={nxProjEmptyHeadingStyle}>No projects yet{canWrite ? '' : '.'}</h3>
          {canWrite && (
            <>
              <p style={nxProjEmptySublineStyle}>a project holds your workflows and their sources</p>
              <button type="button" style={nxProjEmptyCtaStyle} onClick={() => setShowCreate(true)}>
                Create your first project
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" aria-hidden>
                  <path d="M2.5 8h11M9 3.5 13.5 8 9 12.5" />
                </svg>
              </button>
            </>
          )}
        </div>
      ) : (
        <>
          <div style={nxProjColHeaderRowStyle}>
            <span style={{ ...nxProjColHeaderCellStyle, paddingLeft: 20 }}>#</span>
            <span style={nxProjColHeaderCellStyle}>Project</span>
            <span style={nxProjColHeaderCellStyle}>Workflows</span>
            <span style={nxProjColHeaderCellStyle}>Last activity</span>
            <span style={nxProjColHeaderCellStyle} />
            <span style={nxProjColHeaderCellStyle} />
          </div>
          {projects.map((project, i) => {
            const hasWorkflows = project.workflowCount > 0;
            const hasRun = Boolean(project.lastRunAt);
            return (
              <div key={project.id} style={nxProjRowStyle}>
                <span style={nxProjRowIndexCellStyle}>{String(i + 1).padStart(2, '0')}</span>
                <Link href={`/app/projects/${project.id}`} className="nx-wipe" style={nxProjRowNameCellStyle}>
                  <span style={nxProjRowNameStyle}>{project.name}</span>
                </Link>
                <span style={nxProjRowWorkflowsCellStyle(hasWorkflows)}>
                  {hasWorkflows ? `${project.workflowCount} workflow${project.workflowCount === 1 ? '' : 's'}` : 'No workflows'}
                </span>
                <span style={nxProjRowActivityCellStyle}>
                  <span style={nxProjRowActivityDotStyle(hasRun)} />
                  {hasRun ? `Ran ${relativeTime(project.lastRunAt as string)}` : 'No runs yet'}
                </span>
                {canWrite ? (
                  <button type="button" className="nx-wipe" style={nxProjRowDeleteCellStyle} onClick={(e) => onDeleteClick(e, project)}>
                    Delete
                  </button>
                ) : (
                  <span />
                )}
                <Link href={`/app/projects/${project.id}`} className="nx-wipe" style={nxProjRowArrowCellStyle} aria-hidden tabIndex={-1}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" aria-hidden>
                    <path d="M2.5 8h11M9 3.5 13.5 8 9 12.5" />
                  </svg>
                </Link>
              </div>
            );
          })}
        </>
      )}

      {showCreate && <CreateProjectDialog orgId={orgId} onClose={() => setShowCreate(false)} />}

      {deleteTarget && (
        <DeleteConfirmDialog
          title="Delete project?"
          message={`This also deletes its ${deleteTarget.workflowCount} workflow${deleteTarget.workflowCount === 1 ? '' : 's'}. This can't be undone.`}
          hiddenFields={{ projectId: deleteTarget.id, redirectTo: '/app/projects' }}
          action={deleteProject}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </>
  );
}
