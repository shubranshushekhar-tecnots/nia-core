import { z } from "zod";
import type { GraphDoc } from "./graph.js";
import { GraphNodeType, GraphPosition } from "./graph.js";
import { parseNodeConfig, type EntityRef } from "./nodeConfig.js";
import { compilePushdown, type SourceDialect } from "./pushdown.js";

/**
 * Phase 7 Session 1 — Copilot's proposed-graph-mutation contract.
 *
 * Deliberately ADD-ONLY: PlanNode/PlanEdge have no delete/modify
 * representation at all, so there is nothing for validatePlanStructure to
 * reject on that axis — the type system itself is the add-only guarantee
 * (see the Phase 7 plan's Session 1.1 note). Applying a Plan is always
 * "merge these nodes/edges into the existing GraphDoc", never a replace.
 *
 * Node `config` must satisfy `parseNodeConfig()` (nodeConfig.ts) — the same
 * SourceDestConfig/TransformConfig shapes the canvas/compiler already use.
 * No parallel config representation for Copilot-authored nodes.
 *
 * Mirrors checks.ts's pure-vs-injected-I/O split (see that file's header
 * comment): `validatePlanStructure` only ever looks at the Plan + the
 * caller's already-fetched GraphDoc, so it stays fully self-contained and
 * importable by both apps/worker and apps/api, same purity contract as
 * checkConfig/checkDag. `validatePlanFeasibility` needs real I/O (does an
 * EntityRef actually exist upstream? would a proposed aggregate breach the
 * row cap?) — same shape as checkCredentials/checkMappings/checkGrants, the
 * caller (apps/worker's plan engine) owns the actual fetch/probe and injects
 * the result via callbacks, so this module never imports Supabase or
 * connector-dispatch.
 */

// ---- Plan shape -------------------------------------------------------

export const PlanNode = z.object({
  /** Plan-local id (e.g. "new-1") — never collides with an existing GraphNode.id; validatePlanStructure enforces that. */
  id: z.string(),
  type: GraphNodeType,
  connectionId: z.string().uuid().optional(),
  /** Validated against parseNodeConfig at structure-check time, same permissive-at-parse-time/strict-at-check-time split nodeConfig.ts documents. */
  config: z.record(z.string(), z.unknown()).default({}),
  position: GraphPosition,
});
export type PlanNode = z.infer<typeof PlanNode>;

export const PlanEdge = z.object({
  id: z.string(),
  /** Either a plan-local PlanNode.id or an existing GraphNode.id — resolved against the merged node-id set. */
  source: z.string(),
  target: z.string(),
});
export type PlanEdge = z.infer<typeof PlanEdge>;

/**
 * Evidence collected by validatePlanFeasibility's cardinality probe — the
 * observed group count and when it was measured, for one aggregate step on
 * one plan node. Carried on the Plan purely as a record for humans (ghost
 * panel, Session 2) and for Apply to write onto the persisted node's config
 * so a future pagination pass (Block 6) can find every node that was gated
 * on this cap. Never read back as validation input — validatePlanStructure
 * takes no probeResults parameter, and validatePlanFeasibility only ever
 * APPENDS to this array, never trusts a caller-supplied one.
 */
export const PlanAggregateProbeResult = z.object({
  planNodeId: z.string(),
  stepIndex: z.number().int().nonnegative(),
  groupBy: z.array(z.string()),
  observedCount: z.number().int().nonnegative(),
  probedAt: z.string().datetime(),
});
export type PlanAggregateProbeResult = z.infer<typeof PlanAggregateProbeResult>;

export const Plan = z.object({
  /** One-line NL description, shown verbatim in the ghost panel (Session 2) — not re-derived from the nodes/edges. */
  summary: z.string(),
  nodes: z.array(PlanNode).default([]),
  edges: z.array(PlanEdge).default([]),
  /** Evidence only — see PlanAggregateProbeResult's doc comment. Always empty on LLM-generated plans; populated by validatePlanFeasibility. */
  probeResults: z.array(PlanAggregateProbeResult).default([]),
  /**
   * workflow_graphs.version (0012_workflow_graphs.sql's optimistic-
   * concurrency column) as observed when this plan was generated — Session
   * 2's staleness check. Never LLM-supplied: the prompt never mentions this
   * field, so it's absent from every raw LLM response and falls back to
   * this default; the plan engine (resolveScope -> runPlanPropose) always
   * overwrites it with the server-observed value before returning the plan
   * to a caller, the same "never trust an LLM-emitted value for anything
   * consistency-relevant" precedent checkConnections' closed-world check
   * already sets for connectionId. Apply (Session 2) re-fetches the graph's
   * *current* version and refuses (no merge attempt) if it no longer
   * matches this value — the graph changed since this plan was proposed.
   */
  baseGraphVersion: z.number().int().nonnegative().default(0),
});
export type Plan = z.infer<typeof Plan>;

// ---- Plan check result --------------------------------------------------

/**
 * Deliberately a separate type from checks.ts's CheckResult/CheckId rather
 * than extending CheckId with a "plan" member — CheckId is load-bearing for
 * CheckRunJob's `checks` enum (jobs.ts) and the Task 2 check-results UI;
 * widening it for an unrelated feature would be a blast-radius increase for
 * no benefit, since nothing about plan validation is ever run through
 * CheckRunJob. Same {status,message,nodeId} shape by convention, not by
 * shared schema.
 */
export const PlanCheckId = z.enum(["structure", "feasibility"]);
export type PlanCheckId = z.infer<typeof PlanCheckId>;

export const PlanCheckResult = z.object({
  id: PlanCheckId,
  status: z.enum(["pass", "fail"]),
  message: z.string(),
  /** References a PlanNode.id (never an existing GraphNode.id) — the ghost panel highlights the offending proposed node. */
  planNodeId: z.string().optional(),
});
export type PlanCheckResult = z.infer<typeof PlanCheckResult>;

function planNodeLabel(node: PlanNode): string {
  return `${node.id} (${node.type})`;
}

// ---- layout (pure, deterministic) -----------------------------------------

/** Horizontal gap (px) per dependency-depth column, right of the existing graph's rightmost node. Matches ghostMapping.ts's GHOST_COLUMN_GAP. */
const GHOST_COLUMN_GAP = 280;
/** Vertical spacing (px) between nodes stacked within the same column. Matches ghostMapping.ts's GHOST_ROW_GAP. */
const GHOST_ROW_GAP = 140;

/**
 * Deterministic layout for a Plan's nodes, used by BOTH the client-side
 * ghost preview (Session 2, apps/web/.../ghostMapping.ts's planToGhostFlow)
 * and Apply's persisted GraphNode position (Session 2, apps/api's
 * planApply.ts) — one pure function, one source of truth, so a node never
 * visually "jumps" between what the ghost showed and what actually lands
 * on the canvas after Apply.
 *
 * `PlanNode.position` (the field the LLM is prompted to fill in, see
 * apps/worker's planGen.ts prompt) is deliberately NEVER read here — same
 * "never trust an LLM-emitted value for anything consistency-relevant"
 * precedent baseGraphVersion's doc comment and checkConnections' closed-
 * world check already set. The LLM has no knowledge of the *live* canvas
 * viewport or of edits made to the graph after generation (Session 2's own
 * staleness check exists precisely because the graph can move between
 * propose and apply), so its coordinates are not a reliable placement
 * signal — only a required-by-schema placeholder so a PlanNode round-trips
 * through the same shape a GraphNode expects.
 *
 * Algorithm: column = a plan node's dependency depth among plan-local edges
 * only (an edge to/from an existing persisted node anchors that plan node
 * at depth 0 rather than contributing to the chain). Columns sit strictly
 * right of the existing graph's rightmost node (maxX) so a proposed node
 * can never overlap a committed one; row = the node's index within its own
 * column, stacked from the existing graph's topmost node (minY), so
 * proposed nodes can never overlap each other either. Same `plan` +
 * `existingNodePositions` always produces the same output — the "same plan
 * must place identically every time" requirement falls out of this being a
 * pure function of its two inputs, no randomness/Date.now.
 *
 * Takes bare positions rather than a full GraphDoc/CanvasNode[] so both
 * call sites (packages/schemas has no GraphDoc-node-shape mismatch; apps/
 * web's CanvasNode carries React Flow fields this function doesn't need)
 * can pass their own node array's `.position` projection directly.
 */
export function computePlanLayout(
  plan: Plan,
  existingNodePositions: GraphPosition[],
): Record<string, GraphPosition> {
  const maxX = existingNodePositions.length ? Math.max(...existingNodePositions.map((p) => p.x)) : 0;
  const minY = existingNodePositions.length ? Math.min(...existingNodePositions.map((p) => p.y)) : 0;

  const planIds = new Set(plan.nodes.map((n) => n.id));
  const localPreds = new Map<string, string[]>();
  for (const edge of plan.edges) {
    if (planIds.has(edge.source) && planIds.has(edge.target)) {
      localPreds.set(edge.target, [...(localPreds.get(edge.target) ?? []), edge.source]);
    }
  }

  const depthCache = new Map<string, number>();
  function depthOf(id: string, stack: Set<string>): number {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    // Cycle guard — validatePlanStructure already rejects any plan that
    // would introduce a cycle, so this should never trigger in practice;
    // it exists purely so a malformed/unvalidated plan can never hang on a
    // recursive depth computation.
    if (stack.has(id)) return 0;
    stack.add(id);
    const preds = localPreds.get(id) ?? [];
    const depth = preds.length === 0 ? 0 : 1 + Math.max(...preds.map((p) => depthOf(p, stack)));
    depthCache.set(id, depth);
    return depth;
  }

  const rowByColumn = new Map<number, number>();
  const layout: Record<string, GraphPosition> = {};
  for (const planNode of plan.nodes) {
    const depth = depthOf(planNode.id, new Set());
    const row = rowByColumn.get(depth) ?? 0;
    rowByColumn.set(depth, row + 1);
    layout[planNode.id] = { x: maxX + GHOST_COLUMN_GAP * (depth + 1), y: minY + row * GHOST_ROW_GAP };
  }
  return layout;
}

// ---- a. structure (pure) --------------------------------------------------

/**
 * Pure structural validation — no I/O. Checks:
 *  1. Every PlanNode.config parses via parseNodeConfig for its type.
 *  2. No PlanNode.id collides with an existing GraphNode.id in existingGraph.
 *  3. Every PlanEdge's source/target resolves to either a plan node id or an
 *     existing GraphNode.id (dangling ref = fail).
 *  4. Merging plan nodes/edges into existingGraph introduces no cycle —
 *     reuses checkDag's DFS shape (checks.ts), run against the merged graph.
 */
export function validatePlanStructure(plan: Plan, existingGraph: GraphDoc): PlanCheckResult[] {
  const results: PlanCheckResult[] = [];
  const existingIds = new Set(existingGraph.nodes.map((n) => n.id));

  // 1. Config validity.
  for (const node of plan.nodes) {
    const parsed = parseNodeConfig(node.type, node.config);
    if (parsed.unrecognized) {
      results.push({
        id: "structure",
        status: "fail",
        message: `Proposed node ${planNodeLabel(node)} has a config that doesn't match the expected shape for a "${node.type}" node.`,
        planNodeId: node.id,
      });
    }
  }

  // 2. No id collision with the existing graph.
  const seenPlanIds = new Set<string>();
  for (const node of plan.nodes) {
    if (existingIds.has(node.id)) {
      results.push({
        id: "structure",
        status: "fail",
        message: `Proposed node id "${node.id}" collides with an existing node in the workflow.`,
        planNodeId: node.id,
      });
    }
    if (seenPlanIds.has(node.id)) {
      results.push({
        id: "structure",
        status: "fail",
        message: `Proposed node id "${node.id}" is used by more than one proposed node.`,
        planNodeId: node.id,
      });
    }
    seenPlanIds.add(node.id);
  }

  // 3 & 4. Dangling edge refs + cycle check, over the merged node/edge set.
  const mergedIds = new Set<string>([...existingIds, ...seenPlanIds]);
  const outAdj = new Map<string, string[]>();
  for (const edge of existingGraph.edges) {
    outAdj.set(edge.source, [...(outAdj.get(edge.source) ?? []), edge.target]);
  }

  for (const edge of plan.edges) {
    const sourceOk = mergedIds.has(edge.source);
    const targetOk = mergedIds.has(edge.target);
    if (!sourceOk) {
      results.push({ id: "structure", status: "fail", message: `Proposed edge ${edge.id} references an unknown source node "${edge.source}".` });
    }
    if (!targetOk) {
      results.push({ id: "structure", status: "fail", message: `Proposed edge ${edge.id} references an unknown target node "${edge.target}".` });
    }
    if (sourceOk && targetOk) {
      outAdj.set(edge.source, [...(outAdj.get(edge.source) ?? []), edge.target]);
    }
  }

  // Cycle check (DFS, recursion-stack tracking) over the full merged graph — same shape as checks.ts's checkDag.
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>([...mergedIds].map((id) => [id, WHITE]));
  let hasCycle = false;
  function dfs(id: string) {
    if (hasCycle) return;
    color.set(id, GRAY);
    for (const next of outAdj.get(id) ?? []) {
      const c = color.get(next);
      if (c === GRAY) {
        hasCycle = true;
        return;
      }
      if (c === WHITE) dfs(next);
    }
    color.set(id, BLACK);
  }
  for (const id of mergedIds) {
    if (color.get(id) === WHITE) dfs(id);
    if (hasCycle) break;
  }
  if (hasCycle) {
    results.push({ id: "structure", status: "fail", message: "Applying this plan would introduce a cycle into the workflow graph." });
  }

  if (results.length === 0) {
    results.push({ id: "structure", status: "pass", message: "Plan is structurally valid: every node config parses, every edge resolves, no id collisions, no cycles." });
  }
  return results;
}

// ---- b. feasibility (injected I/O) ----------------------------------------

/**
 * Phase 13 gate correction: this used to be MAX_PLAN_AGGREGATE_ROWS = 1000
 * (plus a 50-row PLAN_AGGREGATE_HEADROOM margin), documented from Phase 7
 * authorship as mirroring packages/guardrails/src/sql/validator.ts's
 * DEFAULT_OPTIONS.maxRows / mongodb.ts's DEFAULT_MAX_ROWS /
 * apps/worker/src/lib/etl/queryBuilder.ts's MAX_CHUNK_ROWS — i.e. the OLD
 * single-chunk total-row runtime limit, back when a pushed aggregate ran as
 * one unpaginated query capped at 1000 total rows. Phase 9 Part 3
 * (PHASE9_EXIT.md; docs/decisions.md) replaced that with group-key keyset
 * pagination for every pushed aggregate and explicitly removed the old
 * fail-at-cap guard ("pagination supersedes it") — MAX_CHUNK_ROWS/maxRows
 * still exist, but now only as a per-page size, not a total cap. A pushed
 * aggregate has no group-count limit today; only a RESIDUAL (in-process,
 * un-pushable) aggregate is still capped, by runEtl.ts's
 * DEFAULT_RESIDUAL_GROUP_CAP = 100_000 in-memory accumulator guard. This
 * constant mirrors that same number so the planner's design-time refusal
 * boundary can never drift from the value the runtime actually enforces.
 * No headroom-margin analog here (unlike the old constant) — the runtime
 * check itself is a single hard `> cap` threshold with no margin
 * (runEtl.ts), so a design-time margin below it would just be inventing a
 * stricter rule than what execution actually enforces.
 */
export const RESIDUAL_PLAN_AGGREGATE_GROUP_CAP = 100_000;

/** Caller (plan engine) owns the actual schema-introspection lookup — resolves whether `entity` exists in `connectionId`'s introspected schema. */
export type EntityExistsLookup = (connectionId: string, entity: EntityRef) => Promise<boolean>;

/** Caller (plan engine) owns the connection -> dialect lookup (a pure in-memory map over the same visible-connections list checkConnections already resolved) — used to decide whether a proposed aggregate step would push down (no cap) or run residually (RESIDUAL_PLAN_AGGREGATE_GROUP_CAP applies). Returns null when the connection's dialect can't be resolved — treated as "not pushable", same as compilePushdown's own null-dialect contract. */
export type DialectResolver = (connectionId: string) => SourceDialect | null;

/**
 * Caller owns the actual cardinality probe dispatch (a COUNT(DISTINCT
 * groupBy cols)-shaped read, via the existing dispatch() chokepoint — see
 * apps/worker/src/lib/plan/nodes/probeCardinality.ts). Returns the number of
 * distinct groups a proposed aggregate step would produce.
 *
 * Return a NEGATIVE number when the probe could not be measured (dispatch
 * failure, guardrail rejection, timeout, unresolvable dialect — any reason
 * the caller couldn't get a real count). validatePlanFeasibility treats a
 * negative result as a hard failure, never as "assume 0 / within cap" — an
 * unmeasured aggregate must never fail open into a silent pass.
 */
export type CardinalityProbeFn = (
  connectionId: string,
  entity: EntityRef,
  groupBy: string[],
) => Promise<number>;

export type PlanFeasibilityContext = {
  entityExists: EntityExistsLookup;
  probeCardinality: CardinalityProbeFn;
  resolveDialect: DialectResolver;
  /**
   * Test-only override for RESIDUAL_PLAN_AGGREGATE_GROUP_CAP — omit in
   * production (defaults to the real cap). Exists so the golden eval suite
   * can exercise a genuine cap breach without seeding 100,000+ real rows,
   * same "configurable override, real constant by default" convention as
   * runEtl.ts's RESIDUAL_GROUP_CAP env var (apps/worker/src/lib/etl/
   * runEtl.ts's residualGroupCap()) — see runPlanGoldenSuite.ts for where
   * this gets set, and only there.
   */
  residualGroupCap?: number;
};

/**
 * Injected-context validation — needs real I/O, same shape as checks.ts's
 * checkGrants. For every plan node with a persisted `entity` (SourceDestConfig),
 * confirms it actually exists in the target connection's introspected schema.
 * For every TransformConfig step with `kind: "aggregate"` and a non-empty
 * groupBy, first determines (via compilePushdown, same pure classifier the
 * canvas transform-drawer preview and the real executor both use) whether
 * the step would PUSH DOWN to the source dialect or run RESIDUALLY
 * in-process. A pushed aggregate is never probed/capped — Phase 9 Part 3
 * gave every pushed aggregate group-key keyset pagination, so there is no
 * group-count limit left to enforce at plan time. A residual aggregate is
 * probed and fails if it would breach RESIDUAL_PLAN_AGGREGATE_GROUP_CAP,
 * mirroring runEtl.ts's own in-memory accumulator guard. `groupBy: []`
 * (whole-table aggregate) is always exactly 1 output row — never probed,
 * matching Block 6's own vocabulary (nodeConfig.ts's AggregateStep doc).
 *
 * A node whose config is unrecognized (already flagged by
 * validatePlanStructure) is skipped here rather than re-flagged — structure
 * and feasibility are separate PlanCheckId's specifically so a caller can
 * tell "this plan is malformed" from "this plan is well-formed but
 * infeasible" apart.
 *
 * Two-way outcome per probed RESIDUAL aggregate step (a pushed step is
 * never probed at all — see above):
 *  1. Probe couldn't be measured (negative count) — hard fail, never fail
 *     open. Message says "could not be measured" and still includes the
 *     substring "group cap" so callers keying off that (e.g. apps/worker's
 *     validateFeasibility.ts) still classify it as a capacity-limit
 *     refusal, same as an actual breach.
 *  2. count > RESIDUAL_PLAN_AGGREGATE_GROUP_CAP — breach, hard fail.
 *  3. Otherwise: within cap — recorded as evidence on the returned
 *     probeResults array (see PlanAggregateProbeResult), not re-validated
 *     by anything downstream.
 */
export async function validatePlanFeasibility(
  plan: Plan,
  ctx: PlanFeasibilityContext,
): Promise<{ results: PlanCheckResult[]; probeResults: PlanAggregateProbeResult[] }> {
  const results: PlanCheckResult[] = [];
  const probeResults: PlanAggregateProbeResult[] = [];

  for (const node of plan.nodes) {
    const parsed = parseNodeConfig(node.type, node.config);
    if (parsed.unrecognized) continue;

    if (parsed.type === "source" || parsed.type === "destination") {
      const entity = parsed.value.entity;
      if (entity && node.connectionId) {
        const exists = await ctx.entityExists(node.connectionId, entity);
        if (!exists) {
          results.push({
            id: "feasibility",
            status: "fail",
            message: `Proposed node ${planNodeLabel(node)}: "${entity.namespace}.${entity.name}" does not exist on the selected connection.`,
            planNodeId: node.id,
          });
        }
      }
    } else if (parsed.type === "transform") {
      const sourceEntity = resolveUpstreamEntity(node, plan);
      // Same pure classifier the canvas transform-drawer preview and the
      // real executor use to decide pushed vs. residual — computed once per
      // node (not per step) since it depends on the whole ordered step
      // list, not any single step in isolation (splitPushable's "first
      // non-pushable step and everything after it becomes residual" rule).
      const dialect = sourceEntity?.connectionId ? ctx.resolveDialect(sourceEntity.connectionId) : null;
      const { residualTransforms } = compilePushdown(dialect, parsed.value);
      const cap = ctx.residualGroupCap ?? RESIDUAL_PLAN_AGGREGATE_GROUP_CAP;

      for (const [i, step] of parsed.value.steps.entries()) {
        if (step.kind !== "aggregate" || step.groupBy.length === 0) continue;
        if (!sourceEntity || !sourceEntity.connectionId) continue; // can't probe without a resolvable upstream connection+entity — not a hard failure here.
        // Pushed aggregates get group-key keyset pagination at execution
        // time (Phase 9 Part 3) — no group-count limit left to enforce here.
        if (!residualTransforms.includes(step)) continue;

        const count = await ctx.probeCardinality(sourceEntity.connectionId, sourceEntity.entity, step.groupBy);

        if (count < 0) {
          results.push({
            id: "feasibility",
            status: "fail",
            message: `Proposed node ${planNodeLabel(node)}: aggregate step ${i + 1} (GROUP BY ${step.groupBy.join(", ")}) runs residually and could not be measured against the ${cap}-group cap — refusing rather than assuming it fits.`,
            planNodeId: node.id,
          });
          continue;
        }
        if (count > cap) {
          results.push({
            id: "feasibility",
            status: "fail",
            message: `Proposed node ${planNodeLabel(node)}: aggregate step ${i + 1} (GROUP BY ${step.groupBy.join(", ")}) runs residually and would produce ${count} groups, exceeding the ${cap}-group cap.`,
            planNodeId: node.id,
          });
          continue;
        }

        probeResults.push({
          planNodeId: node.id,
          stepIndex: i,
          groupBy: step.groupBy,
          observedCount: count,
          probedAt: new Date().toISOString(),
        });
      }
    }
  }

  if (results.length === 0) {
    results.push({ id: "feasibility", status: "pass", message: "Every referenced entity exists and every residual (non-pushed) aggregate stays within the group cap." });
  }
  return { results, probeResults };
}

/**
 * Walks a single edge upstream from a transform plan node to find the
 * nearest source's connectionId + persisted entity — plan-local nodes only
 * (Session 1 scope: a Copilot-proposed transform always sits directly
 * downstream of a Copilot-proposed source within the same plan; chaining
 * onto an existing persisted source is a Session 2+ affordance). Returns
 * undefined if no such upstream source is found.
 */
function resolveUpstreamEntity(
  transformNode: PlanNode,
  plan: Plan,
): { connectionId: string; entity: EntityRef } | undefined {
  const incoming = plan.edges.find((e) => e.target === transformNode.id);
  if (!incoming) return undefined;
  const upstream = plan.nodes.find((n) => n.id === incoming.source);
  if (!upstream || upstream.type !== "source" || !upstream.connectionId) return undefined;
  const parsed = parseNodeConfig(upstream.type, upstream.config);
  if (parsed.unrecognized || parsed.type === "transform" || !parsed.value.entity) return undefined;
  return { connectionId: upstream.connectionId, entity: parsed.value.entity };
}

// ---- Propose outcome (worker -> API JSON contract) ---------------------

/**
 * Phase 7 Session 3 — the JSON-safe mirror of
 * apps/worker/src/lib/plan/runPlanPropose.ts's `PlanProposeResult` TS
 * union. runPlanPropose resolves in a single `graph.invoke()` call (no
 * incremental per-node events — see that file's header comment), so
 * plan_propose is a single request/response BullMQ job, same shape as
 * mappings_propose/preview_run/schema_refresh, not an SSE-streamed one
 * like chat_query. This schema is what crosses the worker -> API queue
 * boundary (apps/api/src/lib/planQueue.ts parses the raw job return value
 * against it, mirroring mappingProposal.ts's ProposeMappingOutcome
 * pattern exactly) and is also what the API route/client hand straight to
 * the UI, since the UI must branch on all 5 statuses (not just ok/fail).
 */
export const PlanProposeOutcome = z.discriminatedUnion("status", [
  z.object({ status: z.literal("error"), error: z.string() }),
  z.object({ status: z.literal("no-connection"), message: z.string() }),
  z.object({
    status: z.literal("refused"),
    kind: z.enum(["unsupported-operation", "partial-failure", "capacity-limit"]),
    message: z.string(),
  }),
  z.object({ status: z.literal("clarify"), question: z.string() }),
  z.object({ status: z.literal("ok"), plan: Plan, planGenAttempts: z.number().int().nonnegative() }),
]);
export type PlanProposeOutcome = z.infer<typeof PlanProposeOutcome>;
