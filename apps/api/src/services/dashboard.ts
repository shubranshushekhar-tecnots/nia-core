import { workspaceWhere, type WorkspaceScope } from "@nia/db";
import type { WithUser } from "../lib/withUser.js";
import type { WorkflowStatus } from "./projects.js";

/** 1:1 port of apps/web/src/lib/dashboard/queries.ts's dashboard-facing reads. */
export type RunStatus = "running" | "succeeded" | "failed";

export type DashboardStats = {
  projectCount: number;
  workflowCount: number;
  activeWorkflowCount: number;
  planTier: string;
  workflowLimit: number | null;
  projectLimit: number | null;
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

/**
 * Subscription model Phase 1 (docs/plans/subscription-model.md). Resolves
 * through org_plan/owner_plan -> plans (0049/0050/0051): the override flag
 * decides which side of the `case when` wins, same shape as the
 * enforce_workflow_limit/enforce_project_limit trigger functions
 * (0052/0053). org_plan/owner_plan are guaranteed to have exactly one row
 * per org/user (0043's create trigger, 0051's signup trigger, both
 * backfilled for pre-existing rows), so no left-join-with-default is
 * needed here unlike the pre-0049 version of this function.
 *
 * Reads via the caller's own `withUser`, not `withServiceRole`: org_plan
 * has a member-scoped RLS SELECT policy (0044_org_plan_member_select.sql,
 * `private.is_member(org_id)`) and owner_plan has an owner-scoped one
 * (0051, `user_id = auth.uid()`) — an acting-user query correctly returns
 * only the caller's own row. Neither table grants insert/update/delete to
 * authenticated at all — both remain write-only via service_role/postgres
 * (the create/signup triggers, or Console's service-role PATCH route).
 *
 * `planTier` here is the plan's display name (plans.name — "Free", "Pro",
 * "Legacy", etc.), not the old hardcoded "Pro" literal.
 */
async function getOrgPlan(
  withUser: WithUser,
  scope: WorkspaceScope,
): Promise<{ planTier: string; workflowLimit: number | null; projectLimit: number | null }> {
  const isPersonal = !("orgId" in scope);
  const table = isPersonal ? "owner_plan" : "org_plan";
  const scopeColumn = isPersonal ? "user_id" : "org_id";
  const scopeValue = isPersonal ? scope.ownerId : scope.orgId;

  const { rows } = await withUser((db) =>
    db.query<{ plan_name: string; workflow_limit: number | null; project_limit: number | null }>(
      `select
         pl.name as plan_name,
         case when op.workflow_limit_set then op.workflow_limit else pl.workflow_limit end as workflow_limit,
         case when op.project_limit_set then op.project_limit else pl.project_limit end as project_limit
       from public.${table} op
       join public.plans pl on pl.id = op.plan_id
       where op.${scopeColumn} = $1`,
      [scopeValue],
    ),
  );

  const row = rows[0];
  return {
    planTier: row?.plan_name ?? "Legacy",
    workflowLimit: row ? row.workflow_limit : 25,
    projectLimit: row ? row.project_limit : null,
  };
}

export async function getDashboardStats(withUser: WithUser, scope: WorkspaceScope): Promise<DashboardStats> {
  const [projectsResult, workflowsResult, activeWorkflowsResult, plan] = await Promise.all([
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
    getOrgPlan(withUser, scope),
  ]);

  return {
    projectCount: projectsResult.rows[0]?.count ?? 0,
    workflowCount: workflowsResult.rows[0]?.count ?? 0,
    activeWorkflowCount: activeWorkflowsResult.rows[0]?.count ?? 0,
    planTier: plan.planTier,
    workflowLimit: plan.workflowLimit,
    projectLimit: plan.projectLimit,
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
