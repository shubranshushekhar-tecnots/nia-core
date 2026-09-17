import {
  GraphDoc,
  checkConfig,
  checkCredentials,
  checkDag,
  checkGrants,
  checkMappings,
  parseNodeConfig,
  fieldNamesForSource,
  type CheckResult,
  type CheckRunJob,
  type FieldsLookup,
  type TestConnectionFn,
  type WriteGrantLookup,
} from "@nia/schemas";
import { supabase } from "../supabaseClient.js";
import { resolveConnection } from "../resolveConnection.js";
import { resolveWriteGrant } from "../resolveWriteGrant.js";
import { sendTestRequest } from "../connectorClient.js";
import { getSchema } from "../introspection.js";
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
export async function resolveGraph(workflowId: string, scope: WorkspaceScope): Promise<GraphDoc | null> {
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

  const hasActiveGrant: WriteGrantLookup = async (connectionId, namespace) => {
    const resolved = await resolveWriteGrant(connectionId, namespace);
    return resolved.ok;
  };

  const requested = new Set(job.checks);
  const results: CheckResult[] = [];
  if (requested.has("config")) results.push(...checkConfig(graph));
  if (requested.has("dag")) results.push(...checkDag(graph));
  if (requested.has("grants")) results.push(...(await checkGrants(graph, hasActiveGrant)));
  if (requested.has("credentials")) results.push(...(await checkCredentials(graph, testConnection)));
  if (requested.has("mappings")) {
    results.push(...(await buildMappingsCheck(graph, job.scope)));
  }
  return { results };
}

/**
 * checkMappings (checks.ts) reads a destination's *approved mapping*
 * directly off the GraphDoc it already has — no I/O needed for that half
 * (Task 3). The other half, current introspected field names for each
 * source, is real I/O (a cached connector schema fetch), so it's built here
 * and injected as a FieldsLookup. Only sources feeding a heterogeneous edge
 * are resolved, and any resolve/introspect failure degrades to "unknown"
 * (`undefined`) rather than a hard failure — same precedent as
 * checkCredentials' catch block above: a connectivity hiccup during a check
 * run must never fabricate a false drift failure.
 */
async function buildMappingsCheck(graph: GraphDoc, scope: WorkspaceScope): Promise<CheckResult[]> {
  const destManifestByNodeId = new Map(graph.nodes.filter((n) => n.type === "destination").map((n) => [n.id, n.manifestId]));
  const heterogeneousSourceIds = new Set<string>();
  for (const edge of graph.edges) {
    const source = graph.nodes.find((n) => n.id === edge.source);
    const destManifestId = destManifestByNodeId.get(edge.target);
    if (source?.manifestId && destManifestId && source.manifestId !== destManifestId) {
      heterogeneousSourceIds.add(source.id);
    }
  }

  const fieldsBySourceId = new Map<string, string[]>();
  for (const sourceId of heterogeneousSourceIds) {
    const source = graph.nodes.find((n) => n.id === sourceId);
    if (!source?.connectionId) continue;
    try {
      const resolved = await resolveConnection(source.connectionId, scope);
      if (!resolved.ok) continue;
      const schema = await getSchema(resolved.value);
      if (!schema.ok) continue;
      // Phase 6 Block 0: scope to the source's persisted entity when it
      // resolves against the live schema; falls back to the flat union
      // (pre-Block-0 behavior) otherwise — see fieldNamesForSource's doc.
      const sourceConfig = parseNodeConfig("source", source.config);
      const entity = !sourceConfig.unrecognized && sourceConfig.type !== "transform" ? sourceConfig.value.entity : undefined;
      fieldsBySourceId.set(sourceId, fieldNamesForSource(schema.value, entity));
    } catch {
      // Can't verify drift for this source — checkMappings treats a
      // missing lookup entry as "unknown," not a failure.
    }
  }

  const lookupFields: FieldsLookup = (sourceNodeId) => fieldsBySourceId.get(sourceNodeId);
  return checkMappings(graph, lookupFields);
}
