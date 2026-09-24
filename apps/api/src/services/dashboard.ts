import { workspaceWhere, type WorkspaceScope } from "@nia/db";
import type { WithUser } from "../lib/withUser.js";
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

export async function getDashboardStats(withUser: WithUser, scope: WorkspaceScope): Promise<DashboardStats> {
  const [projectsResult, workflowsResult, activeWorkflowsResult] = await Promise.all([
    withUser((db) => {
      const where = workspaceWhere(scope, 1);
      return db.query<{ count: number }>(`select count(*)::int as count from projects where ${where.sql}`, where.params);
    }),
    withUser((db) => {
      const where = workspaceWhere(scope, 1);
      return db.query<{ count: number }>(`select count(*)::int as count from workflows where ${where.sql}`, where.params);
    }),
    withUser((db) => {
      const where = workspaceWhere(scope, 1);
      return db.query<{ count: number }>(
        `select count(*)::int as count from workflows where ${where.sql} and status = 'active'`,
        where.params,
      );
    }),
  ]);

  return {
    projectCount: projectsResult.rows[0]?.count ?? 0,
    workflowCount: workflowsResult.rows[0]?.count ?? 0,
    activeWorkflowCount: activeWorkflowsResult.rows[0]?.count ?? 0,
  };
}

type ContinueWorkflowRow = {
  id: string;
  name: string;
  status: WorkflowStatus;
  updated_at: string;
  project_name: string | null;
};

export async function getContinueWorkflow(withUser: WithUser, scope: WorkspaceScope): Promise<ContinueWorkflow | null> {
  // workspaceWhere's org_id/owner_id are bare column names, ambiguous
  // against a join where both workflows and projects have those columns —
  // scope via a subquery against the unaliased, unjoined workflows table.
  const where = workspaceWhere(scope, 1);
  const { rows } = await withUser((db) =>
    db.query<ContinueWorkflowRow>(
      `select w.id, w.name, w.status, w.updated_at, p.name as project_name
       from workflows w
       join projects p on p.id = w.project_id
       where w.id in (select id from workflows where ${where.sql})
       order by w.updated_at desc
       limit 1`,
      where.params,
    ),
  );

  const data = rows[0];
  if (!data) return null;

  return {
    id: data.id,
    name: data.name,
    status: data.status,
    updatedAt: data.updated_at,
    projectName: data.project_name ?? "",
  };
}

type RecentRunRow = {
  id: string;
  status: RunStatus;
  rows_processed: number;
  duration_ms: number | null;
  started_at: string;
  workflow_id: string;
  workflow_name: string | null;
};

export async function getRecentRuns(withUser: WithUser, scope: WorkspaceScope, limit = 6): Promise<RecentRun[]> {
  // workspaceWhere's org_id/owner_id are bare column names, ambiguous
  // against a join where both workflow_runs and workflows have those
  // columns — scope via a subquery against the unaliased, unjoined
  // workflow_runs table.
  const where = workspaceWhere(scope, 2);
  const { rows } = await withUser((db) =>
    db.query<RecentRunRow>(
      `select r.id, r.status, r.rows_processed, r.duration_ms, r.started_at, r.workflow_id, w.name as workflow_name
       from workflow_runs r
       join workflows w on w.id = r.workflow_id
       where r.id in (select id from workflow_runs where ${where.sql})
       order by r.started_at desc
       limit $1`,
      [limit, ...where.params],
    ),
  );

  return rows.map((run) => ({
    id: run.id,
    status: run.status,
    workflowId: run.workflow_id,
    workflowName: run.workflow_name ?? "",
    rowsProcessed: run.rows_processed,
    durationMs: run.duration_ms,
    startedAt: run.started_at,
  }));
}
