import { workspaceWhere, type WorkspaceScope } from "@nia/db";
import type { WithUser } from "../lib/withUser.js";

/**
 * 1:1 port of apps/web/src/lib/dashboard/queries.ts's project-facing reads.
 * Same RLS-scoped selects, same org/owner branch, same in-memory shaping —
 * the only difference is the Supabase client and scope arrive as params
 * (built by requireAuth/attachActor) instead of being constructed inline.
 */
export type WorkflowStatus = "draft" | "active" | "paused";

export type SidebarProject = {
  id: string;
  name: string;
  workflows: { id: string; name: string; status: WorkflowStatus }[];
};

export type ProjectListItem = {
  id: string;
  name: string;
  workflowCount: number;
  lastRunAt: string | null;
};

export type ProjectDetail = {
  id: string;
  name: string;
  workflows: { id: string; name: string; status: WorkflowStatus; updatedAt: string }[];
};

type SidebarProjectRow = {
  id: string;
  name: string;
  workflows: { id: string; name: string; status: WorkflowStatus }[];
};

export async function getSidebarProjects(withUser: WithUser, scope: WorkspaceScope): Promise<SidebarProject[]> {
  // Joins workflows, which has its own org_id/owner_id columns — a bare
  // workspaceWhere() would be ambiguous, so scope it to p (projects) via
  // the tableAlias param.
  const where = workspaceWhere(scope, 1, "p");
  const { rows } = await withUser((db) =>
    db.query<SidebarProjectRow>(
      `select p.id, p.name,
         coalesce(
           json_agg(json_build_object('id', w.id, 'name', w.name, 'status', w.status)) filter (where w.id is not null),
           '[]'
         ) as workflows
       from projects p
       left join workflows w on w.project_id = p.id
       where ${where.sql}
       group by p.id, p.name
       order by p.name asc`,
      where.params,
    ),
  );

  return rows.map((project) => ({
    id: project.id,
    name: project.name,
    workflows: project.workflows,
  }));
}

/**
 * Full projects list (the /app/projects page) — name + workflow count from
 * `projects`, plus each project's most recent `workflow_runs.started_at`
 * (joined in-memory through `workflows.project_id`, same reduce-not-SQL-
 * aggregate style as the source). No per-project member avatars — this app
 * has no per-project membership concept.
 */
type ProjectsListRow = { id: string; name: string; workflow_count: number };
type ProjectRunRow = { project_id: string; started_at: string };

export async function getProjectsList(withUser: WithUser, scope: WorkspaceScope): Promise<ProjectListItem[]> {
  // Joins workflows, which has its own org_id/owner_id columns — a bare
  // workspaceWhere() would be ambiguous, so scope it to p (projects) via
  // the tableAlias param.
  const projectsWhere = workspaceWhere(scope, 1, "p");
  const { rows: projects } = await withUser((db) =>
    db.query<ProjectsListRow>(
      `select p.id, p.name, count(w.id)::int as workflow_count
       from projects p
       left join workflows w on w.project_id = p.id
       where ${projectsWhere.sql}
       group by p.id, p.name
       order by p.name asc`,
      projectsWhere.params,
    ),
  );

  // workspaceWhere's org_id/owner_id are bare column names, ambiguous
  // against a join where both workflow_runs and workflows have those
  // columns — scope via a subquery against the unaliased, unjoined
  // workflow_runs table.
  const runsWhere = workspaceWhere(scope, 1);
  const { rows: runs } = await withUser((db) =>
    db.query<ProjectRunRow>(
      `select w.project_id, r.started_at
       from workflow_runs r
       join workflows w on w.id = r.workflow_id
       where r.id in (select id from workflow_runs where ${runsWhere.sql})
       order by r.started_at desc`,
      runsWhere.params,
    ),
  );

  const lastRunByProject = new Map<string, string>();
  for (const run of runs) {
    if (!lastRunByProject.has(run.project_id)) {
      lastRunByProject.set(run.project_id, run.started_at);
    }
  }

  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    workflowCount: project.workflow_count,
    lastRunAt: lastRunByProject.get(project.id) ?? null,
  }));
}

/**
 * Scoped the same way as getSidebarProjects — a project outside the
 * caller's scope simply comes back as null (indistinguishable from
 * "doesn't exist"), same as the source. The route layer turns that into a
 * plain 404 (no 403 vs 404 distinction leaked), matching the source's
 * comment about callers redirecting rather than differentiating.
 */
type ProjectDetailRow = {
  id: string;
  name: string;
  workflows: { id: string; name: string; status: WorkflowStatus; updated_at: string }[];
};

export async function getProjectDetail(
  withUser: WithUser,
  projectId: string,
  scope: WorkspaceScope,
): Promise<ProjectDetail | null> {
  // workspaceWhere's org_id/owner_id are bare column names, ambiguous
  // against a join where both projects and workflows have those columns —
  // scope via a subquery against the unaliased, unjoined projects table.
  const where = workspaceWhere(scope, 2);
  const { rows } = await withUser((db) =>
    db.query<ProjectDetailRow>(
      `select p.id, p.name,
         coalesce(
           json_agg(json_build_object('id', w.id, 'name', w.name, 'status', w.status, 'updated_at', w.updated_at)) filter (where w.id is not null),
           '[]'
         ) as workflows
       from projects p
       left join workflows w on w.project_id = p.id
       where p.id = $1 and p.id in (select id from projects where ${where.sql})
       group by p.id, p.name`,
      [projectId, ...where.params],
    ),
  );

  const data = rows[0];
  if (!data) return null;

  return {
    id: data.id,
    name: data.name,
    workflows: data.workflows
      .map((w) => ({ id: w.id, name: w.name, status: w.status, updatedAt: w.updated_at }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  };
}
