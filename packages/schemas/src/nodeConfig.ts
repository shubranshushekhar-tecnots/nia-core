import { z } from "zod";
import { Operation } from "./manifest.js";
import { ExprSchema, type Expr } from "./expression.js";
import type { GraphNodeType } from "./graph.js";

/**
 * Per-node-type config schemas — Session 2. GraphNode.config
 * (graph.ts) stays a permissive `z.record(string, unknown())` at the
 * persistence layer deliberately (no migration, no data rewrite of
 * existing rows); this file is the stricter shape callers should validate
 * *into* once they know the node's type, via `parseNodeConfig` below. A
 * node whose stored config doesn't match its type's schema (garbage from
 * before this session, or a future-version field) is never rejected — it's
 * carried through unrecognized (`unrecognized: true`) so the canvas can
 * flag it in the drawer instead of losing the workflow.
 */

/**
 * A single source-field -> destination-field pairing. `from`/`to` are field
 * *names* (not ids) since introspected schemas (contract.ts's
 * IntrospectResponse) key fields by name within an entity, and the union-
 * of-entities pattern this codebase already uses for field pickers
 * (TransformEditor.tsx) also only ever surfaces names.
 */
/**
 * from/to intentionally allow "" (not .min(1)) — same reasoning as
 * FilterCondition.field above: the mapping editor autosaves on every
 * pick, so a freshly-added entry (user hasn't chosen a field on one side
 * yet — e.g. the other side's schema is still loading) is a normal
 * transient on-the-wire shape, not a corrupt config. A .min(1) here would
 * make SourceDestConfig fail to parse the instant such an entry lands,
 * flipping the whole node into NodeDrawer's read-only "unrecognized"
 * fallback with no way back except deleting the node — completeness is
 * enforced at check-time instead (checkConfig, checks.ts), not schema-time.
 */
export const MappingEntry = z.object({
  from: z.string(),
  to: z.string(),
});
export type MappingEntry = z.infer<typeof MappingEntry>;

/**
 * Field mapping for a heterogeneous (cross-connector-type) source ->
 * destination path — Task 3. Lives on the *destination* node's config
 * (below), not a separate table: no migration needed, and it travels with
 * the GraphDoc the same way every other per-node setting does.
 *
 * `approvedAt: null` means "proposed/edited but not yet approved" —
 * checkMappings (checks.ts) treats an unapproved mapping as a failing
 * heterogeneous path, same as no mapping at all. Editing `entries` after
 * approval MUST clear `approvedAt` back to null (drift honesty: an approval
 * only ever covers the exact entries it was granted for) — callers that
 * mutate `entries` are responsible for also nulling `approvedAt` in the
 * same update; this schema doesn't enforce that invariant itself since it's
 * a stateless shape, not a state machine.
 *
 * `version` increments on every approval (starts at 1) — a simple audit
 * trail of how many times this mapping has been (re-)approved, not
 * currently read by any check.
 */
export const FieldMapping = z.object({
  version: z.number().int().min(1).default(1),
  entries: z.array(MappingEntry).default([]),
  approvedAt: z.string().nullable().default(null),
});
export type FieldMapping = z.infer<typeof FieldMapping>;

/**
 * Identifies one entity (table/collection) within a connection's introspected
 * schema (contract.ts's IntrospectResponse) by namespace+name — the same pair
 * SchemaEntity uses. A bare string isn't enough: names can collide across
 * namespaces/schemas within one connection.
 */
export const EntityRef = z.object({
  namespace: z.string(),
  name: z.string(),
});
export type EntityRef = z.infer<typeof EntityRef>;

/**
 * Source/destination node config: which verb the node performs. Write verbs
 * are locked in the UI behind a write grant (Phase 6) — see manifest.ts's
 * WRITE_OPERATIONS. `mapping` is only ever populated on destination nodes
 * (source nodes have no field-mapping concept — they're the "from" side) —
 * it's optional on this shared schema rather than splitting source/dest
 * into separate config types, since every other field is identical.
 *
 * `entity` (Phase 6 Block 0): the persisted table/collection selection for a
 * *source* node, set via the drawer's entity picker. Optional and additive —
 * graphs saved before this field existed simply have no `entity`, and every
 * consumer (entityResolution.ts's fieldNamesForSource/findPersistedEntity,
 * proposeMapping, runWorkflowChecks, runPreview) falls back to the prior
 * flat-union/inference behavior when it's absent, so nothing about existing
 * graphs' check/preview/mapping behavior changes just because this field now
 * exists. Also used on destination nodes as of Phase 6 Block 2 — the same
 * drawer entity picker now selects a destination's write target table too
 * (NodeDrawer.tsx), resolved the same way via findPersistedEntity against
 * the destination connection's own introspected schema.
 *
 * `upsertKeys` (Phase 6 Block 3): destination-only, the field names (from
 * the mapping's `to` side) the ETL runner upserts on — required for a
 * destination node to actually run (see apps/worker/src/lib/etl/runEtl.ts),
 * optional here for the same drafting-state reason `entity` is: the drawer
 * autosaves before a user has picked any keys yet.
 */
export const SourceDestConfig = z.object({
  operation: Operation.default("read"),
  mapping: FieldMapping.optional(),
  entity: EntityRef.optional(),
  upsertKeys: z.array(z.string()).optional(),
});
export type SourceDestConfig = z.infer<typeof SourceDestConfig>;

export const FilterOperator = z.enum([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "is_null",
  "is_not_null",
]);
export type FilterOperator = z.infer<typeof FilterOperator>;

/**
 * value is absent for the two unary operators (is_null / is_not_null).
 * field intentionally allows "" (not .min(1)): the transform editor
 * autosaves on every keystroke, so a condition mid-construction (user
 * hasn't picked a field yet — e.g. upstream schema still loading) is a
 * normal, expected on-the-wire shape, not a corrupt config. This schema
 * isn't wired into any execution path yet (Session 2, editor-only), so
 * there's no runtime-safety reason to reject it here.
 */
export const FilterCondition = z.object({
  field: z.string(),
  operator: FilterOperator,
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export type FilterCondition = z.infer<typeof FilterCondition>;

export const FilterStep = z.object({
  kind: z.literal("filter"),
  /** AND-composed only — no OR groups this session, per the plan's explicit scope cut. */
  conditions: z.array(FilterCondition).default([]),
});
export type FilterStep = z.infer<typeof FilterStep>;

export const ComputedFieldStep = z.object({
  kind: z.literal("computed_field"),
  /** Intentionally allows "" — see FilterCondition.field's comment above; a
   * freshly-added step (before the user names it) is a normal transient
   * autosaved state, not a corrupt config. */
  name: z.string(),
  /** Always a parsed AST (expression.ts) — never a raw string — so the pushdown compiler never re-parses untrusted text. */
  expression: ExprSchema,
});
export type ComputedFieldStep = z.infer<typeof ComputedFieldStep> & { expression: Expr };

export const DropFieldsStep = z.object({
  kind: z.literal("drop_fields"),
  fields: z.array(z.string().min(1)).default([]),
});
export type DropFieldsStep = z.infer<typeof DropFieldsStep>;

export const TransformStep = z.discriminatedUnion("kind", [FilterStep, ComputedFieldStep, DropFieldsStep]);
export type TransformStep = z.infer<typeof TransformStep>;

export const TransformConfig = z.object({
  /** Applied in array order — a later step sees the previous step's output shape (e.g. a drop_fields before a filter on a dropped field is a user-visible ordering choice, not validated here). */
  steps: z.array(TransformStep).default([]),
});
export type TransformConfig = z.infer<typeof TransformConfig>;

export type ParsedNodeConfig =
  | { unrecognized: false; type: "source" | "destination"; value: SourceDestConfig }
  | { unrecognized: false; type: "transform"; value: TransformConfig }
  | { unrecognized: true; type: GraphNodeType; raw: Record<string, unknown> };

/**
 * Validates a node's raw (persisted) config against its type's schema.
 * Never throws — a schema mismatch is reported as `unrecognized: true`
 * carrying the original raw value, per this file's header comment.
 */
export function parseNodeConfig(type: GraphNodeType, raw: Record<string, unknown>): ParsedNodeConfig {
  if (type === "transform") {
    const result = TransformConfig.safeParse(raw);
    if (!result.success) return { unrecognized: true, type, raw };
    return { unrecognized: false, type, value: result.data };
  }
  const result = SourceDestConfig.safeParse(raw);
  if (!result.success) return { unrecognized: true, type, raw };
  return { unrecognized: false, type, value: result.data };
}
