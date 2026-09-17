import {
  GraphDoc,
  checkConfig,
  checkCredentials,
  checkDag,
  checkGrants,
  checkMappings,
  type CheckResult,
  type CheckRunJob,
  type TestConnectionFn,
} from "@nia/schemas";
import { supabase } from "../supabaseClient.js";
import { resolveConnection } from "../resolveConnection.js";
import { sendTestRequest } from "../connectorClient.js";
import type { WorkspaceScope } from "../workspaceScope.js";

/** Mirrors apps/api/src/services/workflowGraphs.ts's "never saved" sentinel. */
const EMPTY_GRAPH: GraphDoc = { nodes: [], edges: [] };

/**
 * Re-derives the workflow's WorkspaceScope explicitly, same rationale as
 * resolveConnection.ts: `supabase` here is the service_role client, which
 * bypasses RLS entirely, so this scope filter is the only thing standing
 * between "the worker resolved someone else's workflow" and "the worker
 * correctly refused it." A workflow that exists but belongs to a different
 * org/owner is treated identically to one that doesn't exist.
 */
async function resolveGraph(workflowId: string, scope: WorkspaceScope): Promise<GraphDoc | null> {
  let workflowQuery = supabase.from("workflows").select("id", { count: "exact", head: true }).eq("id", workflowId);
  workflowQuery = "orgId" in scope ? workflowQuery.eq("org_id", scope.orgId) : workflowQuery.is("org_id", null).eq("owner_id", scope.ownerId);
  const { count } = await workflowQuery;
  if (!count) return null;

  const { data } = await supabase.from("workflow_graphs").select("graph").eq("workflow_id", workflowId).maybeSingle();
  return data ? GraphDoc.parse(data.graph) : EMPTY_GRAPH;
}

/**
 * Runs the checks engine (@nia/schemas/checks.ts) for a CheckRunJob. Pure
 * computation only — this function never persists a result. Persistence
 * happens exclusively via the public.record_check_run RPC, called by the
 * Express route through req.supabase (the caller's own JWT), because
 * private.can_access_workflow relies on auth.uid() — a service_role call
 * like this worker's has no auth.uid() and would always be refused. See
 * supabase/migrations/0014_workflow_check_runs.sql's header comment and
 * apps/api/src/services/checks.ts, which owns the RPC call.
 */
export async function runWorkflowChecks(job: CheckRunJob): Promise<{ results: CheckResult[] }> {
  const graph = await resolveGraph(job.workflowId, job.scope);
  if (!graph) {
    return { results: [{ id: "config", status: "fail", message: "Workflow not found in the given workspace." }] };
  }

  const testConnection: TestConnectionFn = async (connectionId) => {
    const resolved = await resolveConnection(connectionId, job.scope);
    if (!resolved.ok) return { ok: false, message: resolved.error.message };
    const tested = await sendTestRequest(resolved.value.manifest, resolved.value.credential, resolved.value.config);
    if (!tested.ok) return { ok: false, message: tested.error.message };
    return { ok: tested.value.ok, message: tested.value.error };
  };

  const requested = new Set(job.checks);
  const results: CheckResult[] = [];
  if (requested.has("config")) results.push(...checkConfig(graph));
  if (requested.has("dag")) results.push(...checkDag(graph));
  if (requested.has("grants")) results.push(...checkGrants(graph));
  if (requested.has("credentials")) results.push(...(await checkCredentials(graph, testConnection)));
  if (requested.has("mappings")) {
    // Task 3 (destination field-mapping schema/UI) hasn't landed yet, so
    // there's no persisted mapping data to look up — both lookups
    // legitimately return "unknown" for every destination node.
    // checkMappings.ts treats an unknown mapping as "no approved mapping"
    // for any heterogeneous source->destination edge (see checks.ts's own
    // header comment on checkMappings) — so today, any workflow pairing
    // two different connector types (e.g. mysql -> supabase, now possible
    // since the supabase connector gained etl_sink) will genuinely FAIL
    // this check. That's an honest reflection of the current gap, not a
    // fabricated pass — once Task 3 lands, swap these two `() => undefined`
    // lookups for real reads of the destination node's persisted mapping
    // and the source's cached introspected fields.
    results.push(...checkMappings(graph, () => undefined, () => undefined));
  }
  return { results };
}
