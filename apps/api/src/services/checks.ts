import type { SupabaseClient } from "@supabase/supabase-js";
import { CheckResult } from "@nia/schemas";
import type { WorkspaceScope } from "../lib/workspaceScope.js";
import { AppError } from "../lib/appError.js";
import { runCheckRunJob } from "../lib/checksQueue.js";

export type WorkflowCheckRun = {
  id: string;
  workflowId: string;
  graphVersion: number;
  results: CheckResult[];
  ranAt: string;
};

const ALL_CHECKS = ["config", "dag", "credentials", "mappings", "grants"] as const;

async function assertWorkflowInScope(supabase: SupabaseClient, scope: WorkspaceScope, workflowId: string): Promise<void> {
  let query = supabase.from("workflows").select("id", { count: "exact", head: true }).eq("id", workflowId);
  query = "orgId" in scope ? query.eq("org_id", scope.orgId) : query.is("org_id", null).eq("owner_id", scope.ownerId);
  const { count } = await query;
  if (!count) throw new AppError(404, "NOT_FOUND", "Workflow not found.");
}

function parseRow(row: { id: string; workflow_id: string; graph_version: number; results: unknown; ran_at: string }): WorkflowCheckRun {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    graphVersion: row.graph_version,
    results: CheckResult.array().parse(row.results),
    ranAt: row.ran_at,
  };
}

/**
 * Runs the full check suite via the worker (lib/checksQueue.ts enqueues a
 * check_run job and blocks on its result — see that file's header comment
 * for why this is synchronous rather than SSE/polling), then persists the
 * results through the public.record_check_run RPC using THIS request's own
 * req.supabase — never the worker's service_role client. That split is
 * required, not just a convention: private.can_access_workflow (called
 * inside the RPC) relies on auth.uid(), which is only ever populated for a
 * request carrying the caller's own JWT, never for a service_role call. See
 * supabase/migrations/0014_workflow_check_runs.sql's header comment.
 */
export async function runAndRecordChecks(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  workflowId: string,
  triggeredByUserId: string,
): Promise<WorkflowCheckRun> {
  await assertWorkflowInScope(supabase, scope, workflowId);

  const results = await runCheckRunJob({
    scope,
    workflowId,
    checks: [...ALL_CHECKS],
    triggeredByUserId,
  });

  const { data, error } = await supabase
    .rpc("record_check_run", { p_workflow: workflowId, p_results: results })
    .single();
  if (error) throw new AppError(403, "CHECK_RUN_DENIED", error.message);

  return parseRow(data as Parameters<typeof parseRow>[0]);
}

export async function getLatestCheckRun(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  workflowId: string,
): Promise<WorkflowCheckRun | null> {
  await assertWorkflowInScope(supabase, scope, workflowId);

  const { data } = await supabase
    .from("workflow_check_runs")
    .select("id, workflow_id, graph_version, results, ran_at")
    .eq("workflow_id", workflowId)
    .order("ran_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data ? parseRow(data) : null;
}
