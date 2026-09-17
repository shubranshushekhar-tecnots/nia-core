import { z } from "zod";
import type { GraphDoc, GraphNode } from "./graph.js";
import { parseNodeConfig } from "./nodeConfig.js";
import { WRITE_OPERATIONS } from "./manifest.js";

/**
 * Checks engine v1 — Phase 5 Session 3. Pure, no I/O, importable by both
 * apps/worker and apps/api (same purity contract as pushdown.ts, which this
 * file deliberately sits beside — see that file's header comment for why
 * packages/schemas, not packages/guardrails, is the right home for a module
 * that only ever inspects a workflow's own already-persisted GraphDoc/config,
 * never untrusted executed SQL/Mongo text).
 *
 * Two of the five checks (credentials, mappings) inherently need I/O — a
 * connector /test call, and introspected-schema data respectively. Rather
 * than import Supabase/connector-dispatch here (which would break the
 * worker+api shared-importability contract), those two checks take the I/O
 * result as an injected parameter/callback and the caller (worker or api
 * service layer) owns the actual fetch + the ~60s test-result cache Task 1c
 * asks for. config/dag/grants are fully self-contained since they only ever
 * look at the GraphDoc already in hand.
 *
 * `id` on a CheckResult is the check *kind* (mirrors CheckRunJob.checks'
 * enum in jobs.ts — config|dag|credentials|mappings|grants), not a
 * per-result unique id: a single check can emit zero, one, or many result
 * rows (one per violation found), or exactly one `pass` row when clean. The
 * UI (Task 2) renders one row per result.
 */

/**
 * Zod-backed (not plain TS unions) so Task 2's Express/worker boundary can
 * runtime-validate a CheckResult[] after it crosses Redis/BullMQ (job.data /
 * job.returnvalue round-trip through JSON, same reason every other
 * cross-process payload in this codebase — GraphDoc, TestResponse, etc. — is
 * a zod schema, not a bare TS type). Every existing call site keeps working
 * unchanged: z.infer produces the identical type the old plain unions did.
 */
export const CheckId = z.enum(["config", "dag", "credentials", "mappings", "grants"]);
export type CheckId = z.infer<typeof CheckId>;
export const CheckStatus = z.enum(["pass", "fail", "warn"]);
export type CheckStatus = z.infer<typeof CheckStatus>;

export const CheckResult = z.object({
  id: CheckId,
  status: CheckStatus,
  message: z.string(),
  nodeId: z.string().optional(),
});
export type CheckResult = z.infer<typeof CheckResult>;

function nodeLabel(node: GraphNode): string {
  return node.manifestId ? `${node.id} (${node.manifestId})` : node.id;
}

// ---- a. config -----------------------------------------------------------

/**
 * Strict per-node config validation. Layers on top of parseNodeConfig
 * (nodeConfig.ts), which is deliberately permissive about mid-edit autosave
 * states (empty filter field, empty computed-field name) — a check run is a
 * different context than an autosave: an empty required field there is a
 * genuine incompleteness, not a transient keystroke, so this function
 * re-flags those cases as failures even though parseNodeConfig itself
 * accepts them. Transform-step expression ASTs are already fully validated
 * by ExprSchema as part of parseNodeConfig (field refs require a non-empty
 * name), so an invalid AST already surfaces as `unrecognized` there — no
 * separate re-validation needed here.
 */
export function checkConfig(graph: GraphDoc): CheckResult[] {
  const results: CheckResult[] = [];

  for (const node of graph.nodes) {
    const parsed = parseNodeConfig(node.type, node.config);
    if (parsed.unrecognized) {
      results.push({
        id: "config",
        status: "fail",
        message: `Node ${nodeLabel(node)} has a config that doesn't match the expected shape for a "${node.type}" node.`,
        nodeId: node.id,
      });
      continue;
    }

    if (parsed.type === "transform") {
      for (const [i, step] of parsed.value.steps.entries()) {
        if (step.kind === "filter") {
          for (const cond of step.conditions) {
            if (cond.field === "") {
              results.push({
                id: "config",
                status: "fail",
                message: `Node ${nodeLabel(node)}: filter step ${i + 1} has a condition with no field selected.`,
                nodeId: node.id,
              });
            }
          }
        } else if (step.kind === "computed_field") {
          if (step.name === "") {
            results.push({
              id: "config",
              status: "fail",
              message: `Node ${nodeLabel(node)}: computed field step ${i + 1} has no output name.`,
              nodeId: node.id,
            });
          }
        }
      }
    } else if (node.type === "source" || node.type === "destination") {
      // A source/destination node's *only* other required field, beyond the
      // operation SourceDestConfig already validates, is which connection it
      // runs against — connectionId lives on GraphNode itself, not inside
      // config, but "required field present" is still exactly what this is.
      if (!node.connectionId) {
        results.push({
          id: "config",
          status: "fail",
          message: `Node ${nodeLabel(node)} has no connection selected.`,
          nodeId: node.id,
        });
      }

      // Same permissive-schema/strict-check-time split as the filter/
      // computed-field cases above: MappingEntry.from/to allow "" so the
      // mapping editor can autosave a freshly-added, not-yet-picked entry
      // (nodeConfig.ts's MappingEntry comment) without the config flipping
      // unrecognized. A check run is not a keystroke though — an entry with
      // either side still unset is genuinely incomplete, so it's re-flagged
      // here, same as checkMappings already re-flags a missing/drifted
      // *approval* for heterogeneous pairs (this is a lower-level,
      // approval-independent completeness gate on the entries themselves).
      if (node.type === "destination" && parsed.value.mapping) {
        for (const [i, entry] of parsed.value.mapping.entries.entries()) {
          if (entry.from === "" || entry.to === "") {
            results.push({
              id: "config",
              status: "fail",
              message: `Node ${nodeLabel(node)}: mapping entry ${i + 1} has no field selected on one or both sides.`,
              nodeId: node.id,
            });
          }
        }
      }

      // Phase 6 Block 0: nudge, don't block. A source node with no
      // persisted `entity` still works today — resolveSourceEntity/
      // fieldNamesForSource (entityResolution.ts) fall back to inferring
      // it from the mapping's field names, same as every graph saved
      // before this field existed. `warn` (not `fail`) so existing
      // graphs/workflows don't regress from a passing/runnable state the
      // instant this check ships — see nodeConfig.ts's `entity` comment.
      if (node.type === "source" && !parsed.value.entity) {
        results.push({
          id: "config",
          status: "warn",
          message: `Node ${nodeLabel(node)}: no table selected — the source table will be inferred from the mapping instead. Pick one explicitly to avoid ambiguous-table errors.`,
          nodeId: node.id,
        });
      }
    }
  }

  if (results.length === 0) {
    results.push({ id: "config", status: "pass", message: "Every node's config is valid and complete." });
  }
  return results;
}

// ---- b. dag ----------------------------------------------------------------

export function checkDag(graph: GraphDoc): CheckResult[] {
  const results: CheckResult[] = [];
  const nodeIds = new Set(graph.nodes.map((n) => n.id));

  if (graph.nodes.length === 0) {
    return [{ id: "dag", status: "fail", message: "Workflow has no nodes." }];
  }

  // Every edge references existing nodes.
  const validEdges = graph.edges.filter((edge) => {
    const sourceOk = nodeIds.has(edge.source);
    const targetOk = nodeIds.has(edge.target);
    if (!sourceOk) {
      results.push({ id: "dag", status: "fail", message: `Edge ${edge.id} references a missing source node "${edge.source}".` });
    }
    if (!targetOk) {
      results.push({ id: "dag", status: "fail", message: `Edge ${edge.id} references a missing target node "${edge.target}".` });
    }
    return sourceOk && targetOk;
  });

  // Adjacency over valid edges only, both directions (out for cycle/path
  // detection, degree for orphan detection).
  const outAdj = new Map<string, string[]>();
  const touched = new Set<string>();
  for (const edge of validEdges) {
    outAdj.set(edge.source, [...(outAdj.get(edge.source) ?? []), edge.target]);
    touched.add(edge.source);
    touched.add(edge.target);
  }

  // No orphan nodes: every node must touch at least one valid edge.
  for (const node of graph.nodes) {
    if (!touched.has(node.id)) {
      results.push({ id: "dag", status: "fail", message: `Node ${nodeLabel(node)} isn't connected to anything.`, nodeId: node.id });
    }
  }

  // Acyclic (DFS with recursion-stack tracking).
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>(graph.nodes.map((n) => [n.id, WHITE]));
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
  for (const node of graph.nodes) {
    if (color.get(node.id) === WHITE) dfs(node.id);
    if (hasCycle) break;
  }
  if (hasCycle) {
    results.push({ id: "dag", status: "fail", message: "The workflow graph contains a cycle." });
  }

  // At least one source -> destination path (only meaningful once acyclic;
  // reachability still terminates fine even with a cycle present, so it's
  // safe to check unconditionally rather than gating on !hasCycle).
  const sources = graph.nodes.filter((n) => n.type === "source");
  const destinations = new Set(graph.nodes.filter((n) => n.type === "destination").map((n) => n.id));
  let pathFound = false;
  for (const source of sources) {
    const seen = new Set<string>();
    const stack = [source.id];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (destinations.has(cur)) {
        pathFound = true;
        break;
      }
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const next of outAdj.get(cur) ?? []) stack.push(next);
    }
    if (pathFound) break;
  }
  if (!pathFound) {
    results.push({ id: "dag", status: "fail", message: "No path from a source node to a destination node." });
  }

  if (results.length === 0) {
    results.push({ id: "dag", status: "pass", message: "The workflow graph is a valid, acyclic, fully-connected DAG." });
  }
  return results;
}

// ---- c. credentials ---------------------------------------------------------

/**
 * `testConnection` is injected — the caller (worker/api) owns the actual
 * connector /test dispatch and the ~60s result cache Task 1c asks for, so
 * this module never imports connectorDispatch/Supabase itself.
 */
export type TestConnectionFn = (connectionId: string) => Promise<{ ok: boolean; message?: string }>;

export async function checkCredentials(graph: GraphDoc, testConnection: TestConnectionFn): Promise<CheckResult[]> {
  const byConnection = new Map<string, GraphNode[]>();
  for (const node of graph.nodes) {
    if (!node.connectionId) continue;
    byConnection.set(node.connectionId, [...(byConnection.get(node.connectionId) ?? []), node]);
  }

  if (byConnection.size === 0) {
    return [{ id: "credentials", status: "pass", message: "No connections referenced." }];
  }

  const results: CheckResult[] = [];
  for (const [connectionId, nodes] of byConnection) {
    const names = nodes.map(nodeLabel).join(", ");
    try {
      const outcome = await testConnection(connectionId);
      if (!outcome.ok) {
        results.push({
          id: "credentials",
          status: "fail",
          message: `Connection used by ${names} failed its test${outcome.message ? `: ${outcome.message}` : "."}`,
          nodeId: nodes[0]!.id,
        });
      }
    } catch (err) {
      results.push({
        id: "credentials",
        status: "fail",
        message: `Connection used by ${names} could not be tested: ${err instanceof Error ? err.message : String(err)}`,
        nodeId: nodes[0]!.id,
      });
    }
  }

  if (results.length === 0) {
    results.push({ id: "credentials", status: "pass", message: "Every referenced connection passed its test." });
  }
  return results;
}

// ---- d. mappings --------------------------------------------------------

/**
 * Reads the mapping straight off the destination node's own config
 * (nodeConfig.ts's FieldMapping, added Task 3) via parseNodeConfig — no
 * injected lookup needed for this half, since a node's own config is
 * already in the GraphDoc the caller has in hand, with no I/O involved.
 * Current introspected field names for a source node, or undefined if
 * unknown (not yet introspected/cached), are still injected: this is real
 * I/O (a connector schema fetch) that must stay out of this pure module —
 * treated as "can't verify" rather than a hard failure, to avoid
 * false-negative drift reports when introspection data simply isn't cached
 * yet.
 */
export type FieldsLookup = (sourceNodeId: string) => string[] | undefined;

export function checkMappings(graph: GraphDoc, lookupFields: FieldsLookup): CheckResult[] {
  const results: CheckResult[] = [];
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));

  for (const dest of graph.nodes) {
    if (dest.type !== "destination") continue;
    const incoming = graph.edges.filter((e) => e.target === dest.id);
    for (const edge of incoming) {
      const source = nodesById.get(edge.source);
      if (!source) continue; // reported separately by checkDag.

      const heterogeneous = Boolean(source.manifestId && dest.manifestId && source.manifestId !== dest.manifestId);
      if (!heterogeneous) continue; // homogeneous/unresolved paths pass automatically.

      const parsed = parseNodeConfig(dest.type, dest.config);
      const mapping = !parsed.unrecognized && parsed.type !== "transform" ? parsed.value.mapping : undefined;
      if (!mapping || !mapping.approvedAt) {
        results.push({
          id: "mappings",
          status: "fail",
          message: `${nodeLabel(source)} -> ${nodeLabel(dest)} crosses connector types and has no approved field mapping.`,
          nodeId: dest.id,
        });
        continue;
      }

      const currentFields = lookupFields(source.id);
      if (currentFields === undefined) continue; // can't verify drift without introspection data — not a failure.

      const currentSet = new Set(currentFields);
      for (const entry of mapping.entries) {
        if (!currentSet.has(entry.from)) {
          results.push({
            id: "mappings",
            status: "fail",
            message: `${nodeLabel(source)} -> ${nodeLabel(dest)}: mapped source field "${entry.from}" no longer exists upstream.`,
            nodeId: dest.id,
          });
        }
      }
    }
  }

  if (results.length === 0) {
    results.push({ id: "mappings", status: "pass", message: "Every heterogeneous source-to-destination path has an approved, drift-free mapping." });
  }
  return results;
}

// ---- e. grants ------------------------------------------------------------

const WRITE_OPERATION_SET = new Set<string>(WRITE_OPERATIONS);

/**
 * The Phase 6 tripwire: write verbs are locked out of the UI entirely right
 * now, so this should always pass trivially. It deliberately reads the RAW
 * node.config (not the parsed value) so it still catches a write verb even
 * inside a config that otherwise fails checkConfig's strict parse — a
 * malformed-but-dangerous config must never slip past this check just
 * because it's also malformed.
 */
export function checkGrants(graph: GraphDoc): CheckResult[] {
  const results: CheckResult[] = [];
  for (const node of graph.nodes) {
    const operation = (node.config as Record<string, unknown>).operation;
    if (typeof operation === "string" && WRITE_OPERATION_SET.has(operation)) {
      results.push({
        id: "grants",
        status: "fail",
        message: `Node ${nodeLabel(node)} has write operation "${operation}" configured — write verbs are not permitted yet.`,
        nodeId: node.id,
      });
    }
  }
  if (results.length === 0) {
    results.push({ id: "grants", status: "pass", message: "No write operations configured anywhere in this workflow." });
  }
  return results;
}
