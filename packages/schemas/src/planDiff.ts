import { z } from "zod";
import { GraphDoc, GraphNode, GraphEdge, type GraphDoc as GraphDocType, type GraphNode as GraphNodeType, type GraphEdge as GraphEdgeType } from "./graph.js";
import { TransformStep, parseNodeConfig, ensureStepIds, updateStepProvenance, type TransformStep as TransformStepType, type StepProvenance } from "./nodeConfig.js";
import type { PlanCheckResult } from "./plan.js";

/**
 * Phase 12 — the diff model (docs/plans/phase12.md). A PlanDiff is a list
 * of operations addressed by stable id (GraphNode.id/GraphEdge.id, or a
 * TransformStep's own `id`, see nodeConfig.ts's Phase 12 addition), not a
 * JSON patch: every update/remove op carries a full "before" snapshot of
 * the element it touches, and every add/update op carries the full
 * "after" element. This is deliberately more verbose on the wire than a
 * patch would be, in exchange for two properties a patch can't give for
 * free: (1) `invertDiff` below is a pure, total function with no need to
 * re-fetch anything — the "before" of every op IS the "after" of its
 * inverse, and vice versa; (2) `checkRevertConflicts` can tell whether the
 * live graph still matches what a plan actually did without re-deriving
 * that from a patch's start state.
 *
 * Unlike plan.ts's `Plan` (Copilot's existing add-only propose/apply
 * contract, Phase 7 — deliberately untouched by this file, see this
 * package's index.ts and PHASE12_EXIT.md for why), a PlanDiff can also
 * remove and update. Nothing in Copilot's propose path emits one yet
 * (Phase 13's specialists are the first) — this module is the engine
 * Phase 13 will route through, exercised directly by apps/api's
 * copilotDiffApply.ts in the meantime.
 */

// ---- Op shapes ----------------------------------------------------------

export const AddNodeOp = z.object({ kind: z.literal("addNode"), node: GraphNode });
export type AddNodeOp = z.infer<typeof AddNodeOp>;

export const RemoveNodeOp = z.object({ kind: z.literal("removeNode"), nodeId: z.string(), before: GraphNode });
export type RemoveNodeOp = z.infer<typeof RemoveNodeOp>;

export const UpdateNodeOp = z.object({ kind: z.literal("updateNode"), nodeId: z.string(), before: GraphNode, after: GraphNode });
export type UpdateNodeOp = z.infer<typeof UpdateNodeOp>;

export const AddEdgeOp = z.object({ kind: z.literal("addEdge"), edge: GraphEdge });
export type AddEdgeOp = z.infer<typeof AddEdgeOp>;

export const RemoveEdgeOp = z.object({ kind: z.literal("removeEdge"), edgeId: z.string(), before: GraphEdge });
export type RemoveEdgeOp = z.infer<typeof RemoveEdgeOp>;

/**
 * Step ops carry BOTH a top-level `stepId` and the snapshot's own `.id` —
 * same pattern node ops already use (`nodeId` alongside `before`/`after`,
 * each of which also carries its own `.id`). `index`/`fromIndex`/`toIndex`
 * are positions within the owning transform node's `TransformConfig.steps`
 * array at op-construction time, needed so `invertDiff` can restore an
 * add/removed step to its exact original position, not just "somewhere".
 */
export const AddStepOp = z.object({
  kind: z.literal("addStep"),
  nodeId: z.string(),
  stepId: z.string(),
  step: TransformStep,
  index: z.number().int().nonnegative(),
});
export type AddStepOp = z.infer<typeof AddStepOp>;

export const RemoveStepOp = z.object({
  kind: z.literal("removeStep"),
  nodeId: z.string(),
  stepId: z.string(),
  before: TransformStep,
  index: z.number().int().nonnegative(),
});
export type RemoveStepOp = z.infer<typeof RemoveStepOp>;

export const UpdateStepOp = z.object({
  kind: z.literal("updateStep"),
  nodeId: z.string(),
  stepId: z.string(),
  before: TransformStep,
  after: TransformStep,
});
export type UpdateStepOp = z.infer<typeof UpdateStepOp>;

export const MoveStepOp = z.object({
  kind: z.literal("moveStep"),
  nodeId: z.string(),
  stepId: z.string(),
  fromIndex: z.number().int().nonnegative(),
  toIndex: z.number().int().nonnegative(),
});
export type MoveStepOp = z.infer<typeof MoveStepOp>;

export const PlanOp = z.discriminatedUnion("kind", [
  AddNodeOp,
  RemoveNodeOp,
  UpdateNodeOp,
  AddEdgeOp,
  RemoveEdgeOp,
  AddStepOp,
  RemoveStepOp,
  UpdateStepOp,
  MoveStepOp,
]);
export type PlanOp = z.infer<typeof PlanOp>;

export const PlanDiff = z.object({
  summary: z.string(),
  /** Same staleness-detection contract as plan.ts's Plan.baseGraphVersion — see that field's doc comment. */
  baseGraphVersion: z.number().int().nonnegative().default(0),
  ops: z.array(PlanOp).default([]),
});
export type PlanDiff = z.infer<typeof PlanDiff>;

/**
 * Phase 12 — stamps `provenance` onto every step an `addStep`/`updateStep`
 * op carries (`op.step`/`op.after` respectively), returning a new PlanDiff.
 * All other op kinds pass through unchanged.
 *
 * Must be called BEFORE `validateDiffStructure`/`applyDiffToGraph` and
 * before the diff is persisted (copilotDiffApply.ts's `applyPlanDiff` does
 * both against the SAME stamped diff) — never as a side effect inside
 * `applyDiffToGraph` itself. If the graph write and the persisted diff
 * snapshot ever disagreed on a step's provenance, `checkRevertConflicts`'s
 * `deepEqual(cur, op.after)` would permanently see a mismatch on every
 * step-touching plan (live step has `provenance`, the stored `op.after`
 * doesn't) and falsely refuse every revert. Stamping once, up front, keeps
 * the applied graph, the persisted diff, and all later conflict/round-trip
 * comparisons mutually consistent — this function itself stays a pure,
 * engine-agnostic transform of a diff, not tied to any one apply path.
 */
export function stampDiffStepProvenance(diff: PlanDiff, provenance: StepProvenance): PlanDiff {
  return {
    ...diff,
    ops: diff.ops.map((op) => {
      if (op.kind === "addStep") return { ...op, step: updateStepProvenance(op.step, provenance) };
      if (op.kind === "updateStep") return { ...op, after: updateStepProvenance(op.after, provenance) };
      return op;
    }),
  };
}

// ---- internal working-graph representation ------------------------------

type WorkingGraph = {
  nodes: Map<string, GraphNodeType>;
  edges: Map<string, GraphEdgeType>;
};

function toWorkingGraph(graph: GraphDocType): WorkingGraph {
  return {
    nodes: new Map(graph.nodes.map((n) => [n.id, n])),
    edges: new Map(graph.edges.map((e) => [e.id, e])),
  };
}

function fromWorkingGraph(g: WorkingGraph, graph: GraphDocType): GraphDocType {
  return { nodes: [...g.nodes.values()], edges: [...g.edges.values()], parkedLegacyTriggers: graph.parkedLegacyTriggers };
}

function stepsOfNode(node: GraphNodeType): TransformStepType[] | null {
  if (node.type !== "transform") return null;
  const parsed = parseNodeConfig("transform", node.config);
  if (parsed.unrecognized || parsed.type !== "transform") return null;
  return parsed.value.steps;
}

function withSteps(node: GraphNodeType, steps: TransformStepType[]): GraphNodeType {
  const parsed = parseNodeConfig("transform", node.config);
  const base = parsed.unrecognized ? node.config : parsed.value;
  return { ...node, config: { ...base, steps } };
}

/**
 * Structural (order/type-independent) deep equality over plain JSON-safe
 * values — GraphNode/GraphEdge/TransformStep never carry Date/Map/etc. A
 * key present with value `undefined` is treated as equivalent to that key
 * being absent (both mean "no value"), since object-spread merges used
 * throughout this file and its callers routinely produce one or the other
 * depending on which side of a spread an optional field came from —
 * treating them as different would make the round-trip test flaky based
 * on incidental spread order, not any real structural difference.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const aKeys = Object.keys(a as Record<string, unknown>).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const bKeys = Object.keys(b as Record<string, unknown>).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((k) => bKeys.includes(k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}

/**
 * Applies one op to the working graph in place, pushing a human-readable
 * message onto `errors` for anything that doesn't hold (target missing,
 * id collision, or the live element no longer matches the op's recorded
 * "before" snapshot — this last case is what makes a corrupted/stale diff
 * fail loudly instead of silently landing a wrong "before" as someone's
 * new current state). Applying an op whose target is missing/mismatched is
 * still attempted where structurally possible (best-effort), matching
 * validatePlanStructure's "keep going, collect every failure" convention
 * (plan.ts) rather than stopping at the first error.
 */
function applyOp(g: WorkingGraph, op: PlanOp, errors: string[]): void {
  switch (op.kind) {
    case "addNode": {
      if (g.nodes.has(op.node.id)) {
        errors.push(`addNode: node id "${op.node.id}" already exists.`);
        break;
      }
      g.nodes.set(op.node.id, op.node);
      break;
    }
    case "removeNode": {
      const cur = g.nodes.get(op.nodeId);
      if (!cur) {
        errors.push(`removeNode: node "${op.nodeId}" does not exist.`);
        break;
      }
      if (!deepEqual(cur, op.before)) errors.push(`removeNode: node "${op.nodeId}" has changed since this diff was created.`);
      g.nodes.delete(op.nodeId);
      break;
    }
    case "updateNode": {
      const cur = g.nodes.get(op.nodeId);
      if (!cur) {
        errors.push(`updateNode: node "${op.nodeId}" does not exist.`);
        break;
      }
      if (!deepEqual(cur, op.before)) errors.push(`updateNode: node "${op.nodeId}" has changed since this diff was created.`);
      g.nodes.set(op.nodeId, op.after);
      break;
    }
    case "addEdge": {
      if (g.edges.has(op.edge.id)) {
        errors.push(`addEdge: edge id "${op.edge.id}" already exists.`);
        break;
      }
      if (!g.nodes.has(op.edge.source)) errors.push(`addEdge ${op.edge.id}: unknown source node "${op.edge.source}".`);
      if (!g.nodes.has(op.edge.target)) errors.push(`addEdge ${op.edge.id}: unknown target node "${op.edge.target}".`);
      g.edges.set(op.edge.id, op.edge);
      break;
    }
    case "removeEdge": {
      const cur = g.edges.get(op.edgeId);
      if (!cur) {
        errors.push(`removeEdge: edge "${op.edgeId}" does not exist.`);
        break;
      }
      if (!deepEqual(cur, op.before)) errors.push(`removeEdge: edge "${op.edgeId}" has changed since this diff was created.`);
      g.edges.delete(op.edgeId);
      break;
    }
    case "addStep": {
      const node = g.nodes.get(op.nodeId);
      if (!node) {
        errors.push(`addStep: node "${op.nodeId}" does not exist.`);
        break;
      }
      const steps = stepsOfNode(node);
      if (!steps) {
        errors.push(`addStep: node "${op.nodeId}" is not a transform node with a recognized config.`);
        break;
      }
      if (steps.some((s) => s.id === op.stepId)) {
        errors.push(`addStep: step id "${op.stepId}" already exists on node "${op.nodeId}".`);
        break;
      }
      const next = [...steps];
      next.splice(Math.min(op.index, next.length), 0, { ...op.step, id: op.stepId });
      g.nodes.set(op.nodeId, withSteps(node, next));
      break;
    }
    case "removeStep": {
      const node = g.nodes.get(op.nodeId);
      if (!node) {
        errors.push(`removeStep: node "${op.nodeId}" does not exist.`);
        break;
      }
      const steps = stepsOfNode(node);
      const idx = steps?.findIndex((s) => s.id === op.stepId) ?? -1;
      if (!steps || idx === -1) {
        errors.push(`removeStep: step "${op.stepId}" not found on node "${op.nodeId}".`);
        break;
      }
      if (!deepEqual(steps[idx], op.before)) errors.push(`removeStep: step "${op.stepId}" on node "${op.nodeId}" has changed since this diff was created.`);
      g.nodes.set(op.nodeId, withSteps(node, steps.filter((_, i) => i !== idx)));
      break;
    }
    case "updateStep": {
      const node = g.nodes.get(op.nodeId);
      if (!node) {
        errors.push(`updateStep: node "${op.nodeId}" does not exist.`);
        break;
      }
      const steps = stepsOfNode(node);
      const idx = steps?.findIndex((s) => s.id === op.stepId) ?? -1;
      if (!steps || idx === -1) {
        errors.push(`updateStep: step "${op.stepId}" not found on node "${op.nodeId}".`);
        break;
      }
      if (!deepEqual(steps[idx], op.before)) errors.push(`updateStep: step "${op.stepId}" on node "${op.nodeId}" has changed since this diff was created.`);
      const next = [...steps];
      next[idx] = { ...op.after, id: op.stepId };
      g.nodes.set(op.nodeId, withSteps(node, next));
      break;
    }
    case "moveStep": {
      const node = g.nodes.get(op.nodeId);
      if (!node) {
        errors.push(`moveStep: node "${op.nodeId}" does not exist.`);
        break;
      }
      const steps = stepsOfNode(node);
      const idx = steps?.findIndex((s) => s.id === op.stepId) ?? -1;
      if (!steps || idx === -1) {
        errors.push(`moveStep: step "${op.stepId}" not found on node "${op.nodeId}".`);
        break;
      }
      if (idx !== op.fromIndex) errors.push(`moveStep: step "${op.stepId}" on node "${op.nodeId}" is at index ${idx}, not the diff's recorded fromIndex ${op.fromIndex}.`);
      const next = [...steps];
      const [moved] = next.splice(idx, 1);
      next.splice(Math.min(op.toIndex, next.length), 0, moved!);
      g.nodes.set(op.nodeId, withSteps(node, next));
      break;
    }
  }
}

// ---- structure validation -------------------------------------------------

/**
 * Simulates applying `diff.ops` (in order) against `existingGraph`,
 * collecting every structural failure along the way (missing/mismatched
 * targets, id collisions — see applyOp above) plus two whole-graph checks
 * run against the resulting state: no dangling edges (a removeNode not
 * paired with explicit removeEdge ops for its edges leaves one — see
 * phase12.md Design A) and no cycle (same DFS shape as plan.ts's
 * validatePlanStructure). Pure, no I/O — same contract as that function.
 */
export function validateDiffStructure(diff: PlanDiff, existingGraph: GraphDocType): PlanCheckResult[] {
  const errors: string[] = [];
  const g = toWorkingGraph(existingGraph);

  for (const op of diff.ops) {
    if (op.kind === "addNode" || op.kind === "updateNode") {
      const node = op.kind === "addNode" ? op.node : op.after;
      const parsed = parseNodeConfig(node.type, node.config);
      if (parsed.unrecognized) errors.push(`${op.kind} ${node.id}: config doesn't match the expected shape for a "${node.type}" node.`);
    }
  }

  for (const op of diff.ops) applyOp(g, op, errors);

  for (const edge of g.edges.values()) {
    if (!g.nodes.has(edge.source) || !g.nodes.has(edge.target)) {
      errors.push(
        `Edge "${edge.id}" would reference a node that no longer exists — removeNode must be accompanied by an explicit removeEdge for every edge touching it.`,
      );
    }
  }

  const outAdj = new Map<string, string[]>();
  for (const edge of g.edges.values()) outAdj.set(edge.source, [...(outAdj.get(edge.source) ?? []), edge.target]);
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>([...g.nodes.keys()].map((id) => [id, WHITE]));
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
  for (const id of g.nodes.keys()) {
    if (color.get(id) === WHITE) dfs(id);
    if (hasCycle) break;
  }
  if (hasCycle) errors.push("Applying this diff would introduce a cycle into the workflow graph.");

  if (errors.length === 0) {
    return [{ id: "structure", status: "pass", message: "Diff is structurally valid: every op resolves, no dangling edges, no cycles." }];
  }
  return errors.map((message) => ({ id: "structure", status: "fail", message }));
}

/**
 * Applies `diff.ops` to `graph`, returning the resulting GraphDoc. Throws
 * if any op doesn't structurally resolve — callers MUST call
 * validateDiffStructure first and refuse on any "fail" result; this
 * function is not itself a validation gate; matches copilotApply.ts's
 * existing applyPlan() precedent of a separate validate-then-apply pair
 * rather than one function silently ignoring problems.
 */
export function applyDiffToGraph(diff: PlanDiff, graph: GraphDocType): GraphDocType {
  const g = toWorkingGraph(graph);
  const errors: string[] = [];
  for (const op of diff.ops) applyOp(g, op, errors);
  if (errors.length > 0) throw new Error(`applyDiffToGraph: diff does not resolve against this graph — ${errors.join(" ")}`);
  return fromWorkingGraph(g, graph);
}

/**
 * Backfills a missing `id` onto every step of every transform node in
 * `graph` (nodeConfig.ts's ensureStepIds) — the "assigned on read for
 * existing steps" half of Phase 12's step-id requirement. Called by the
 * diff-apply service (apps/api's copilotDiffApply.ts) against the
 * just-fetched graph, before validating/applying any diff, so every step a
 * diff might address by id is guaranteed to have one; the backfilled graph
 * is what actually gets persisted (whether or not the diff itself touches
 * that particular node), establishing id stability going forward.
 */
export function ensureGraphStepIds(graph: GraphDocType): GraphDocType {
  const nodes = graph.nodes.map((node) => {
    if (node.type !== "transform") return node;
    const steps = stepsOfNode(node);
    if (!steps) return node;
    return withSteps(node, ensureStepIds(steps));
  });
  return { ...graph, nodes };
}

// ---- revert ---------------------------------------------------------------

function invertOp(op: PlanOp): PlanOp {
  switch (op.kind) {
    case "addNode":
      return { kind: "removeNode", nodeId: op.node.id, before: op.node };
    case "removeNode":
      return { kind: "addNode", node: op.before };
    case "updateNode":
      return { kind: "updateNode", nodeId: op.nodeId, before: op.after, after: op.before };
    case "addEdge":
      return { kind: "removeEdge", edgeId: op.edge.id, before: op.edge };
    case "removeEdge":
      return { kind: "addEdge", edge: op.before };
    case "addStep":
      return { kind: "removeStep", nodeId: op.nodeId, stepId: op.stepId, before: { ...op.step, id: op.stepId }, index: op.index };
    case "removeStep":
      return { kind: "addStep", nodeId: op.nodeId, stepId: op.stepId, step: op.before, index: op.index };
    case "updateStep":
      return { kind: "updateStep", nodeId: op.nodeId, stepId: op.stepId, before: op.after, after: op.before };
    case "moveStep":
      return { kind: "moveStep", nodeId: op.nodeId, stepId: op.stepId, fromIndex: op.toIndex, toIndex: op.fromIndex };
  }
}

/**
 * Builds the inverse of a diff: same ops, reversed order, each individually
 * inverted (see invertOp) — applying `diff` then `invertDiff(diff, ...)` in
 * sequence is required to deep-equal the graph's pre-`diff` state (proven
 * by planDiff.test.ts's round-trip test for every op kind). `baseGraphVersion`
 * is NOT derived from `diff` — a revert always targets the graph's current
 * (live) version at revert time, which the caller (copilotDiffApply.ts's
 * revertPlan) supplies after its own fresh fetch, same as Apply never
 * trusting a client-cached version.
 */
export function invertDiff(diff: PlanDiff, opts: { baseGraphVersion: number; summary?: string }): PlanDiff {
  return {
    summary: opts.summary ?? `Revert: ${diff.summary}`,
    baseGraphVersion: opts.baseGraphVersion,
    ops: [...diff.ops].reverse().map(invertOp),
  };
}

/**
 * Revert's pre-flight check (phase12.md Design C): for every op in the
 * ORIGINAL (not inverted) diff, confirms the live graph's element still
 * matches what that op left behind — an add/update op's `after`, or a
 * remove op's target still being absent. Returns every mismatch found
 * (never stops at the first one, same "collect everything" convention as
 * validateDiffStructure) rather than merging/guessing — "no automatic
 * merging" per the plan.
 */
export function checkRevertConflicts(diff: PlanDiff, currentGraph: GraphDocType): { ok: boolean; conflicts: string[] } {
  const conflicts: string[] = [];
  const nodesById = new Map(currentGraph.nodes.map((n) => [n.id, n]));
  const edgesById = new Map(currentGraph.edges.map((e) => [e.id, e]));

  function liveSteps(nodeId: string): TransformStepType[] | null {
    const node = nodesById.get(nodeId);
    return node ? stepsOfNode(node) : null;
  }

  for (const op of diff.ops) {
    switch (op.kind) {
      case "addNode": {
        const cur = nodesById.get(op.node.id);
        if (!cur || !deepEqual(cur, op.node)) conflicts.push(`Node "${op.node.id}" was changed or removed since this plan was applied.`);
        break;
      }
      case "removeNode": {
        if (nodesById.has(op.nodeId)) conflicts.push(`Node "${op.nodeId}" (removed by this plan) exists again since — can't revert.`);
        break;
      }
      case "updateNode": {
        const cur = nodesById.get(op.nodeId);
        if (!cur || !deepEqual(cur, op.after)) conflicts.push(`Node "${op.nodeId}" was changed since this plan was applied.`);
        break;
      }
      case "addEdge": {
        const cur = edgesById.get(op.edge.id);
        if (!cur || !deepEqual(cur, op.edge)) conflicts.push(`Edge "${op.edge.id}" was changed or removed since this plan was applied.`);
        break;
      }
      case "removeEdge": {
        if (edgesById.has(op.edgeId)) conflicts.push(`Edge "${op.edgeId}" (removed by this plan) exists again since — can't revert.`);
        break;
      }
      case "addStep": {
        const steps = liveSteps(op.nodeId);
        const cur = steps?.find((s) => s.id === op.stepId);
        if (!steps || !cur || !deepEqual(cur, { ...op.step, id: op.stepId })) {
          conflicts.push(`Step "${op.stepId}" on node "${op.nodeId}" was changed or removed since this plan was applied.`);
        }
        break;
      }
      case "removeStep": {
        const steps = liveSteps(op.nodeId);
        if (steps?.some((s) => s.id === op.stepId)) conflicts.push(`Step "${op.stepId}" (removed by this plan) exists again on node "${op.nodeId}" since — can't revert.`);
        break;
      }
      case "updateStep": {
        const steps = liveSteps(op.nodeId);
        const cur = steps?.find((s) => s.id === op.stepId);
        if (!steps || !cur || !deepEqual(cur, { ...op.after, id: op.stepId })) {
          conflicts.push(`Step "${op.stepId}" on node "${op.nodeId}" was changed since this plan was applied.`);
        }
        break;
      }
      case "moveStep": {
        const steps = liveSteps(op.nodeId);
        const idx = steps?.findIndex((s) => s.id === op.stepId) ?? -1;
        if (idx === -1) conflicts.push(`Step "${op.stepId}" on node "${op.nodeId}" was removed since this plan was applied.`);
        else if (idx !== op.toIndex) conflicts.push(`Step "${op.stepId}" on node "${op.nodeId}" was moved again since this plan was applied.`);
        break;
      }
    }
  }
  return { ok: conflicts.length === 0, conflicts };
}
