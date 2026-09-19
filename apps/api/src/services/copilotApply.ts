import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  Plan,
  type Plan as PlanType,
  type GraphDoc as GraphDocType,
  type GraphNode,
  type GraphEdge,
  computePlanLayout,
  validatePlanStructure,
  parseNodeConfig,
} from "@nia/schemas";
import type { WorkspaceScope } from "../lib/workspaceScope.js";
import { AppError } from "../lib/appError.js";
import { getWorkflowGraph, putWorkflowGraph, type WorkflowGraphResult } from "./workflowGraphs.js";
import { listConnections } from "./connections.js";

export type ApplyPlanResult = WorkflowGraphResult & { appliedNodeIds: string[] };

/**
 * Phase 7 Session 2 — Apply. Per the approved plan, this is deliberately
 * NOT its own write path: the only real mutation below is the existing
 * putWorkflowGraph() (workflowGraphs.ts) — same RLS-gated UPDATE every
 * ordinary canvas save already goes through. Everything else here is pure
 * merge/remap/re-validate, done fresh against a just-fetched graph so a
 * stale ghost (proposed against an older graph) can never silently land.
 *
 * ID remap: PlanNode.id is a plan-local string (e.g. "new-1"), never a
 * uuid — GraphNode.id has no format constraint in the schema, but
 * log_plan_applied() (0019_copilot_plan_audit.sql) takes p_applied_node_ids
 * as uuid[], so real uuids are minted here (randomUUID(), same precedent
 * checksQueue.ts/schemaRefreshQueue.ts already use for jobId) and every
 * PlanEdge source/target that refers to a plan-local id is rewritten to
 * the matching real id. An edge endpoint that isn't a plan-local id is
 * assumed to reference an existing GraphNode.id verbatim (validated by the
 * re-run of validatePlanStructure below).
 */
export async function applyPlan(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  workflowId: string,
  input: { plan: unknown; prompt?: string },
): Promise<ApplyPlanResult> {
  const plan: PlanType = Plan.parse(input.plan);

  // Fresh fetch — never trust a client-cached graph as the merge base.
  const current = await getWorkflowGraph(supabase, scope, workflowId);

  if (current.version !== plan.baseGraphVersion) {
    throw new AppError(
      409,
      "PLAN_STALE",
      "This workflow changed since the plan was proposed. Discard the ghost preview and try again.",
    );
  }

  // Defense-in-depth: cheap, pure, no new I/O — catches any drift between
  // propose-time and apply-time graph state beyond the version bump itself
  // (e.g. a concurrent save that landed at the *same* version number is
  // impossible since version always bumps on change, but re-checking here
  // costs nothing and matches the approved plan's Step 3).
  const structureResults = validatePlanStructure(plan, current.graph);
  const structureFailure = structureResults.find((r) => r.status === "fail");
  if (structureFailure) {
    throw new AppError(422, "PLAN_INVALID", structureFailure.message, { results: structureResults });
  }

  const idRemap = new Map<string, string>(plan.nodes.map((n) => [n.id, randomUUID()]));

  const connections = await listConnections(supabase, scope);
  const connectorIdByConnectionId = new Map(connections.map((c) => [c.id, c.connectorId]));

  const layout = computePlanLayout(
    plan,
    current.graph.nodes.map((n) => n.position),
  );

  const newNodes: GraphNode[] = plan.nodes.map((planNode) => {
    const config = stampProbeResults(planNode.id, planNode.config, plan.probeResults);
    return {
      id: idRemap.get(planNode.id)!,
      type: planNode.type,
      connectionId: planNode.connectionId,
      manifestId: planNode.connectionId ? connectorIdByConnectionId.get(planNode.connectionId) : undefined,
      position: layout[planNode.id] ?? planNode.position,
      config,
    };
  });

  const newEdges: GraphEdge[] = plan.edges.map((planEdge) => ({
    id: randomUUID(),
    source: idRemap.get(planEdge.source) ?? planEdge.source,
    target: idRemap.get(planEdge.target) ?? planEdge.target,
  }));

  const merged: GraphDocType = {
    nodes: [...current.graph.nodes, ...newNodes],
    edges: [...current.graph.edges, ...newEdges],
    parkedLegacyTriggers: current.graph.parkedLegacyTriggers,
  };

  const written = await putWorkflowGraph(supabase, scope, workflowId, {
    graph: merged,
    expectedVersion: current.version,
  });

  const appliedNodeIds = newNodes.map((n) => n.id);

  // Separate, non-transactional statement — same "second, best-effort step
  // after the main operation" precedent dispatch.ts/writeDispatch.ts
  // already use for logExecutionAudit, not wrapped in a shared transaction
  // with the graph write above. Throws (rather than swallows) on failure,
  // matching logExecutionAudit's own precedent (executionAudit.ts) — the
  // audit log is load-bearing (CLAUDE.md), so a failed audit write must
  // surface as a distinct error, not disappear silently.
  const { error: auditError } = await supabase.rpc("log_plan_applied", {
    p_workflow_id: workflowId,
    p_plan_summary: plan.summary,
    p_prompt: input.prompt ?? null,
    p_applied_node_ids: appliedNodeIds,
    p_graph_version: written.version,
  });
  if (auditError) throw new AppError(500, "AUDIT_WRITE_FAILED", auditError.message);

  return { ...written, appliedNodeIds };
}

/** Stamps validatePlanFeasibility's cardinality-probe evidence onto the matching aggregate step's config, once, at apply time — see AggregateStep.observedCount/probedAt's doc comment (nodeConfig.ts). */
function stampProbeResults(
  planNodeId: string,
  config: Record<string, unknown>,
  probeResults: PlanType["probeResults"],
): Record<string, unknown> {
  const relevant = probeResults.filter((p) => p.planNodeId === planNodeId);
  if (relevant.length === 0) return config;

  const parsed = parseNodeConfig("transform", config);
  if (parsed.unrecognized || parsed.type !== "transform") return config;

  const steps = parsed.value.steps.map((step, i) => {
    if (step.kind !== "aggregate") return step;
    const probe = relevant.find((p) => p.stepIndex === i);
    if (!probe) return step;
    return { ...step, observedCount: probe.observedCount, probedAt: probe.probedAt };
  });

  return { ...parsed.value, steps };
}
