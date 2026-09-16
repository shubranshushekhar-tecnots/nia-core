import type { SupabaseClient } from "@supabase/supabase-js";
import { GraphDoc, type GraphDoc as GraphDocType } from "@nia/schemas";
import type { WorkspaceScope } from "../lib/workspaceScope.js";
import { AppError } from "../lib/appError.js";

export type WorkflowGraphResult = { graph: GraphDocType; version: number };

/**
 * Version 0 is the "never saved" sentinel (documented on GraphDoc and on
 * the GET route below): a workflow that has no workflow_graphs row yet
 * reads back as this default doc at version 0, not a 404, so the canvas
 * can treat "brand new workflow" and "existing empty graph" (version >= 1)
 * as distinct UI states if it ever needs to.
 */
const EMPTY_GRAPH: GraphDocType = { nodes: [], edges: [] };

async function assertWorkflowInScope(supabase: SupabaseClient, scope: WorkspaceScope, workflowId: string): Promise<void> {
  let query = supabase.from("workflows").select("id", { count: "exact", head: true }).eq("id", workflowId);
  query = "orgId" in scope ? query.eq("org_id", scope.orgId) : query.is("org_id", null).eq("owner_id", scope.ownerId);
  const { count } = await query;
  if (!count) throw new AppError(404, "NOT_FOUND", "Workflow not found.");
}

export async function getWorkflowGraph(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  workflowId: string,
): Promise<WorkflowGraphResult> {
  await assertWorkflowInScope(supabase, scope, workflowId);

  const { data } = await supabase.from("workflow_graphs").select("graph, version").eq("workflow_id", workflowId).maybeSingle();
  if (!data) return { graph: EMPTY_GRAPH, version: 0 };
  return { graph: GraphDoc.parse(data.graph), version: data.version };
}

/**
 * expectedVersion 0 means "the client believes this workflow has never
 * been saved" (per getWorkflowGraph's sentinel above). Two tabs can race
 * to be the first save: both read {version: 0}, both PUT with
 * expectedVersion 0. `upsert(..., { ignoreDuplicates: true })` compiles to
 * `INSERT ... ON CONFLICT (workflow_id) DO NOTHING`, so exactly one of
 * them creates the row; the loser sees an empty result (not an error) and
 * falls through to the same conditional UPDATE every later save uses —
 * which now matches zero rows (the winner's row is already at version 1,
 * not 0) and produces the same 409 as any other conflict. Net: the first
 * save race resolves to one winner + one ordinary 409, no special case
 * for the caller.
 */
export async function putWorkflowGraph(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  workflowId: string,
  input: { graph: GraphDocType; expectedVersion: number },
): Promise<WorkflowGraphResult> {
  await assertWorkflowInScope(supabase, scope, workflowId);

  if (input.expectedVersion === 0) {
    const { data: inserted, error: insertError } = await supabase
      .from("workflow_graphs")
      .upsert({ workflow_id: workflowId, graph: input.graph }, { onConflict: "workflow_id", ignoreDuplicates: true })
      .select("graph, version")
      .maybeSingle();
    if (insertError) throw new AppError(500, "GRAPH_WRITE_FAILED", insertError.message);
    if (inserted) return { graph: GraphDoc.parse(inserted.graph), version: inserted.version };
    // Conflict — someone else's INSERT won. Fall through to the standard
    // conditional UPDATE below; it will affect 0 rows and produce a 409.
  }

  // The version this UPDATE sets is discarded by workflow_graphs_bump_version
  // whenever graph actually changes (0012_workflow_graphs.sql) — that
  // trigger is what guarantees the increment, not this statement. This
  // WHERE clause is the 409 decision: 0 rows affected means another
  // session's save already moved the row past expectedVersion.
  const { data, error } = await supabase
    .from("workflow_graphs")
    .update({ graph: input.graph })
    .eq("workflow_id", workflowId)
    .eq("version", input.expectedVersion)
    .select("graph, version")
    .maybeSingle();

  if (error) throw new AppError(500, "GRAPH_WRITE_FAILED", error.message);
  if (!data) throw new AppError(409, "VERSION_CONFLICT", "This workflow was saved by another session. Reload and retry.");

  return { graph: GraphDoc.parse(data.graph), version: data.version };
}
