'use client';

import { useState, type MouseEvent } from 'react';
import Link from 'next/link';
import { deleteProject } from '@/lib/dashboard/actions';
import type { ProjectListItem } from '@/lib/dashboard/types';
import { relativeTime } from '@/lib/time';
import {
  primaryBtnStyle,
  projectHeaderRowStyle,
  projectListActivityStyle,
  projectListCountStyle,
  projectListDeleteBtnStyle,
  projectListEmptyStyle,
  projectListEmptyTextStyle,
  projectListNameColStyle,
  projectListNameStyle,
  projectListRowStyle,
  projectListStyle,
  projectTitleStyle,
} from './styles';
import CreateProjectDialog from './CreateProjectDialog';
import DeleteConfirmDialog from './DeleteConfirmDialog';

// Ported from the design's `isProjects` section (designs/Nia Core App.html):
// title + "New project" header, then a flat list of rows (name + workflow
// count / last-run activity / delete), 1px bottom border, no card wrapping.
// The design's per-row member-avatar cluster is not ported — this app has
// no per-project membership concept (only whole-org membership), so there's
// no real data to back it.
export default function ProjectsListClient({ orgId, projects }: { orgId: string | null; projects: ProjectListItem[] }) {
  const [showCreate, setShowCreate] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProjectListItem | null>(null);

  function onDeleteClick(e: MouseEvent, project: ProjectListItem) {
    e.preventDefault();
    e.stopPropagation();
    setDeleteTarget(project);
  }

  return (
    <>
      <div style={projectHeaderRowStyle}>
        <span style={projectTitleStyle}>Projects</span>
        <button type="button" style={primaryBtnStyle} onClick={() => setShowCreate(true)}>
          New project
        </button>
      </div>

      {projects.length === 0 ? (
        <div style={projectListEmptyStyle}>
          <span style={projectListEmptyTextStyle}>No projects yet — a project holds your workflows and their sources</span>
          <button type="button" style={primaryBtnStyle} onClick={() => setShowCreate(true)}>
            Create your first project
          </button>
        </div>
      ) : (
        <div style={projectListStyle}>
          {projects.map((project) => (
            <Link key={project.id} href={`/app/projects/${project.id}`} style={projectListRowStyle}>
              <span style={projectListNameColStyle}>
                <span style={projectListNameStyle}>{project.name}</span>
                <span style={projectListCountStyle}>
                  {project.workflowCount === 0
                    ? 'No workflows'
                    : `${project.workflowCount} workflow${project.workflowCount === 1 ? '' : 's'}`}
                </span>
              </span>
              <span style={projectListActivityStyle}>
                {project.lastRunAt ? `Ran ${relativeTime(project.lastRunAt)}` : 'No runs yet'}
              </span>
              <button type="button" style={projectListDeleteBtnStyle} onClick={(e) => onDeleteClick(e, project)}>
                Delete
              </button>
            </Link>
          ))}
        </div>
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
