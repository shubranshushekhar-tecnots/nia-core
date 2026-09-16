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

/** Source/destination node config: which verb the node performs. Write verbs are locked in the UI behind a write grant (Phase 6) — see manifest.ts's WRITE_OPERATIONS. */
export const SourceDestConfig = z.object({
  operation: Operation.default("read"),
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
