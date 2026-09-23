import { z } from "zod";

/**
 * Builder canvas persistence shape — Phase 5 Session 1. Stored verbatim in
 * workflow_graphs.graph (0012_workflow_graphs.sql), always Zod-parsed on
 * write (the jsonb column itself only enforces "valid json", never this
 * shape) and on read (defends against any row written before a future
 * schema tightening).
 *
 * Replaces the old ad hoc { nodes, wires } shape (workflows.definition,
 * 0006_workflow_definition.sql) — 5 node kinds incl. "trigger"/"file", flat
 * x/y, [from, to] wire tuples, free-text `tool`. This session's GraphDoc is
 * deliberately narrower: 3 kinds only (source/transform/destination — no
 * triggers yet, reserved per packages/schemas/src/manifest.ts's Capability
 * enum), typed {x,y} position, and edge objects with handle slots for
 * multi-port nodes later.
 */

export const GraphNodeType = z.enum(["source", "transform", "destination"]);
export type GraphNodeType = z.infer<typeof GraphNodeType>;

export const GraphPosition = z.object({
  x: z.number(),
  y: z.number(),
});
export type GraphPosition = z.infer<typeof GraphPosition>;

export const GraphNode = z.object({
  id: z.string(),
  type: GraphNodeType,
  /** public.connections.id — which of the org's/user's actual connections this node runs against. Absent for a bare, not-yet-wired transform. */
  connectionId: z.string().uuid().optional(),
  /**
   * A connector manifest's `id` (packages/schemas/src/manifest.ts's
   * ConnectorManifest.id — e.g. "mysql"), same string space as
   * connections.connector_id. Named manifestId here (not connectorId) to
   * keep this doc's vocabulary about "which manifest drives this node's
   * palette entry/capabilities", distinct from the connection row itself.
   */
  manifestId: z.string().regex(/^[a-z0-9-]+$/).optional(),
  position: GraphPosition,
  /** Empty this session — per-node typed config forms are Session 2. */
  config: z.record(z.string(), z.unknown()).default({}),
});
export type GraphNode = z.infer<typeof GraphNode>;

export const GraphEdge = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  sourceHandle: z.string().optional(),
  targetHandle: z.string().optional(),
});
export type GraphEdge = z.infer<typeof GraphEdge>;

export const GraphDoc = z.object({
  nodes: z.array(GraphNode).default([]),
  edges: z.array(GraphEdge).default([]),
  /**
   * One-time landing spot for 'trigger'-kind nodes carried over from the
   * legacy workflows.definition column by the (separate, not-yet-written)
   * cutover script — triggers aren't a supported GraphDoc node type yet
   * (etl_source/etl_sink/queryable only, per manifest.ts's Capability
   * enum). Never written by the canvas itself; purely so the migration is
   * non-destructive instead of silently dropping trigger nodes. Absent on
   * every graph created fresh by this session's canvas.
   */
  parkedLegacyTriggers: z.array(z.record(z.string(), z.unknown())).optional(),
});
export type GraphDoc = z.infer<typeof GraphDoc>;
