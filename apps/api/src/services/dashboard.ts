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
 * Console v1 follow-up ("Slice 2 nearly approved" review, req. 2). Mirrors
 * apps/api/src/routes/console.ts's exact `case when op.org_id is null`
 * left-join pattern (not `coalesce`) so a missing org_plan row (an org
 * created before 0043's trigger existed, or any other gap) defaults to the
 * same Pro/25 constant getPlanUsage() has always returned, while a row
 * that explicitly has `workflow_limit = null` (unlimited, per org_plan's
 * own column comment) is preserved rather than collapsed into a default.
 *
 * Reads via the caller's own `withUser`, not `withServiceRole`: org_plan
 * (0042_org_plan.sql) now has a member-scoped RLS SELECT policy
 * (0044_org_plan_member_select.sql, `private.is_member(org_id)`), so an
 * acting-user query correctly returns the caller's own org's row (or zero
 * rows, if org_plan predates 0043's trigger — handled by the same Pro/25
 * default below) without needing a service-role bypass. org_plan still has
 * no insert/update/delete grant for authenticated at all — it remains
 * write-only via service_role/postgres (today: only the 0043 trigger).
 *
 * Personal/individual workspaces (`"ownerId" in scope`, see
 * 0005_individual_workspace.sql) have no `organizations` row at all, so
 * org_plan structurally cannot apply — skip the query entirely and return
 * the same Pro/25 default directly.
 */
async function getOrgPlan(
  withUser: WithUser,
  scope: WorkspaceScope,
): Promise<{ planTier: string; workflowLimit: number | null }> {
  if (!("orgId" in scope)) {
    return { planTier: "Pro", workflowLimit: 25 };
  }

  const { rows } = await withUser((db) =>
    db.query<{ plan_tier: string; workflow_limit: number | null }>(
      `select
         case when op.org_id is null then 'Pro' else op.plan_tier end as plan_tier,
         case when op.org_id is null then 25 else op.workflow_limit end as workflow_limit
       from (select $1::uuid as id) o
       left join public.org_plan op on op.org_id = o.id`,
      [scope.orgId],
    ),
  );

  // The subquery always produces exactly one row (a literal $1 wrapped in
  // its own select), so rows[0] existing is not in question — but
  // workflow_limit itself can legitimately BE null (unlimited), so it must
  // be read as-is, not defaulted with `??` the way plan_tier safely can be
  // (plan_tier is `not null` in the schema; the case-when above already
  // guarantees a string either way).
  const row = rows[0];
  return {
    planTier: row?.plan_tier ?? "Pro",
    workflowLimit: row ? row.workflow_limit : 25,
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
