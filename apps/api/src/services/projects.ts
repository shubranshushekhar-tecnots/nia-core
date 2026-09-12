import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkspaceScope } from "../lib/workspaceScope.js";

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

export async function getSidebarProjects(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
): Promise<SidebarProject[]> {
  let query = supabase.from("projects").select("id, name, workflows ( id, name, status )");
  query = "orgId" in scope ? query.eq("org_id", scope.orgId) : query.is("org_id", null).eq("owner_id", scope.ownerId);
  const { data } = await query.order("name", { ascending: true });

  return (data ?? []).map((project) => ({
    id: project.id,
    name: project.name,
    workflows: (project.workflows ?? []) as SidebarProject["workflows"],
  }));
}

/**
 * Full projects list (the /app/projects page) — name + workflow count from
 * `projects`, plus each project's most recent `workflow_runs.started_at`
 * (joined in-memory through `workflows.project_id`, same reduce-not-SQL-
 * aggregate style as the source). No per-project member avatars — this app
 * has no per-project membership concept.
 */
export async function getProjectsList(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
): Promise<ProjectListItem[]> {
  let projectsQuery = supabase.from("projects").select("id, name, workflows ( id )");
  projectsQuery =
    "orgId" in scope
      ? projectsQuery.eq("org_id", scope.orgId)
      : projectsQuery.is("org_id", null).eq("owner_id", scope.ownerId);
  const { data: projects } = await projectsQuery.order("name", { ascending: true });

  let runsQuery = supabase.from("workflow_runs").select("started_at, workflows ( project_id )");
  runsQuery =
    "orgId" in scope
      ? runsQuery.eq("org_id", scope.orgId)
      : runsQuery.is("org_id", null).eq("owner_id", scope.ownerId);
  const { data: runs } = await runsQuery.order("started_at", { ascending: false });

  const lastRunByProject = new Map<string, string>();
  for (const run of runs ?? []) {
    const workflow = run.workflows as unknown as { project_id: string } | null;
    if (workflow && !lastRunByProject.has(workflow.project_id)) {
      lastRunByProject.set(workflow.project_id, run.started_at);
    }
  }

  return (projects ?? []).map((project) => ({
    id: project.id,
    name: project.name,
    workflowCount: (project.workflows ?? []).length,
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
export async function getProjectDetail(
  supabase: SupabaseClient,
  projectId: string,
  scope: WorkspaceScope,
): Promise<ProjectDetail | null> {
  let query = supabase
    .from("projects")
    .select("id, name, workflows ( id, name, status, updated_at )")
    .eq("id", projectId);
  query = "orgId" in scope ? query.eq("org_id", scope.orgId) : query.is("org_id", null).eq("owner_id", scope.ownerId);
  const { data } = await query.maybeSingle();

  if (!data) return null;

  const workflows = (data.workflows ?? []) as {
    id: string;
    name: string;
    status: WorkflowStatus;
    updated_at: string;
  }[];

  return {
    id: data.id,
    name: data.name,
    workflows: workflows
      .map((w) => ({ id: w.id, name: w.name, status: w.status, updatedAt: w.updated_at }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  };
}
