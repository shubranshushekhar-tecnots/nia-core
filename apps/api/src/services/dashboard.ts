import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkspaceScope } from "../lib/workspaceScope.js";
import type { WorkflowStatus } from "./projects.js";

/** 1:1 port of apps/web/src/lib/dashboard/queries.ts's dashboard-facing reads. */
export type RunStatus = "running" | "succeeded" | "failed";

export type DashboardStats = {
  projectCount: number;
  workflowCount: number;
  activeWorkflowCount: number;
};

export type ContinueWorkflow = {
  id: string;
  name: string;
  status: WorkflowStatus;
  projectName: string;
  updatedAt: string;
};

export type RecentRun = {
  id: string;
  status: RunStatus;
  workflowId: string;
  workflowName: string;
  rowsProcessed: number;
  durationMs: number | null;
  startedAt: string;
};

export async function getDashboardStats(supabase: SupabaseClient, scope: WorkspaceScope): Promise<DashboardStats> {
  let projectsQuery = supabase.from("projects").select("id", { count: "exact", head: true });
  let workflowsQuery = supabase.from("workflows").select("id", { count: "exact", head: true });
  let activeWorkflowsQuery = supabase.from("workflows").select("id", { count: "exact", head: true });

  if ("orgId" in scope) {
    projectsQuery = projectsQuery.eq("org_id", scope.orgId);
    workflowsQuery = workflowsQuery.eq("org_id", scope.orgId);
    activeWorkflowsQuery = activeWorkflowsQuery.eq("org_id", scope.orgId);
  } else {
    projectsQuery = projectsQuery.is("org_id", null).eq("owner_id", scope.ownerId);
    workflowsQuery = workflowsQuery.is("org_id", null).eq("owner_id", scope.ownerId);
    activeWorkflowsQuery = activeWorkflowsQuery.is("org_id", null).eq("owner_id", scope.ownerId);
  }

  const [{ count: projectCount }, { count: workflowCount }, { count: activeWorkflowCount }] = await Promise.all([
    projectsQuery,
    workflowsQuery,
    activeWorkflowsQuery.eq("status", "active"),
  ]);

  return {
    projectCount: projectCount ?? 0,
    workflowCount: workflowCount ?? 0,
    activeWorkflowCount: activeWorkflowCount ?? 0,
  };
}

export async function getContinueWorkflow(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
): Promise<ContinueWorkflow | null> {
  let query = supabase.from("workflows").select("id, name, status, updated_at, projects ( name )");
  query = "orgId" in scope ? query.eq("org_id", scope.orgId) : query.is("org_id", null).eq("owner_id", scope.ownerId);
  const { data } = await query.order("updated_at", { ascending: false }).limit(1).maybeSingle();

  if (!data) return null;
  const project = data.projects as unknown as { name: string } | null;

  return {
    id: data.id,
    name: data.name,
    status: data.status,
    updatedAt: data.updated_at,
    projectName: project?.name ?? "",
  };
}

export async function getRecentRuns(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  limit = 6,
): Promise<RecentRun[]> {
  let query = supabase
    .from("workflow_runs")
    .select("id, status, rows_processed, duration_ms, started_at, workflow_id, workflows ( name )");
  query = "orgId" in scope ? query.eq("org_id", scope.orgId) : query.is("org_id", null).eq("owner_id", scope.ownerId);
  const { data } = await query.order("started_at", { ascending: false }).limit(limit);

  return (data ?? []).map((run) => {
    const workflow = run.workflows as unknown as { name: string } | null;
    return {
      id: run.id,
      status: run.status,
      workflowId: run.workflow_id,
      workflowName: workflow?.name ?? "",
      rowsProcessed: run.rows_processed,
      durationMs: run.duration_ms,
      startedAt: run.started_at,
    };
  });
}
