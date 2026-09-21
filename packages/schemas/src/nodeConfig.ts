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
  /** Only meaningful for operator: "contains". Phase 8b-2b: `contains` is
   * case-SENSITIVE by default (predictable, doesn't vary by column
   * collation) — absent/false means the default; true opts into a
   * case-insensitive match. */
  caseInsensitive: z.boolean().optional(),
});
export type FilterCondition = z.infer<typeof FilterCondition>;

/**
 * Phase 8b-1: a single condition's {field,operator,value} triple upcast
 * onto the unified Expr grammar (expression.ts) — is_null/is_not_null/
 * contains become boolean call-fns, every other operator becomes a
 * `comparison` node. Kept private (not exported) — it's an implementation
 * detail of the legacy-shape upcast below, not a public conversion API.
 */
function toComparisonExpr(cond: FilterCondition): Expr {
  const field: Expr = { kind: "field", name: cond.field };
  switch (cond.operator) {
    case "is_null":
      return { kind: "call", fn: "is_null", args: [field] };
    case "is_not_null":
      return { kind: "call", fn: "is_not_null", args: [field] };
    case "contains": {
      const args: Expr[] = [field, { kind: "literal", value: String(cond.value ?? "") }];
      if (cond.caseInsensitive) args.push({ kind: "literal", value: true });
      return { kind: "call", fn: "contains", args };
    }
    default: {
      const opMap: Record<"eq" | "neq" | "gt" | "gte" | "lt" | "lte", Extract<Expr, { kind: "comparison" }>["op"]> = {
        eq: "eq",
        neq: "neq",
        gt: "gt",
        gte: "gte",
        lt: "lt",
        lte: "lte",
      };
      return { kind: "comparison", op: opMap[cond.operator], left: field, right: { kind: "literal", value: cond.value ?? "" } };
    }
  }
}

/**
 * AND-combines a flat list of legacy FilterConditions into one boolean
 * Expr — the exact semantics FilterStep.conditions/AggregateStep.having
 * had before Phase 8b-1 unified them into the Expr grammar. `[]` (no
 * conditions, i.e. "match everything") becomes the boolean literal
 * `true` rather than an empty `logical/and` node, since `logical.args`
 * requires at least one operand to type-check as boolean (ExprSchema's
 * superRefine, expression.ts). Exported: reused by the legacy-shape Zod
 * upcast below AND by the web op editors (FilterStepEditor/
 * AggregateStepEditor) to repack their row-based UI state into an Expr.
 */
export function conditionsToExpr(conditions: FilterCondition[]): Expr {
  const nodes = conditions.map(toComparisonExpr);
  if (nodes.length === 0) return { kind: "literal", value: true };
  if (nodes.length === 1) return nodes[0]!;
  return { kind: "logical", op: "and", args: nodes };
}

/**
 * Inverse of conditionsToExpr, best-effort: unpacks a boolean Expr back
 * into a flat FilterCondition[] IF it's exactly the flat
 * (comparison|is_null|is_not_null|contains call)+ AND-combined shape this
 * module ever produces — the shape the row-based FilterStepEditor/
 * AggregateStepEditor UI can edit. Returns null for anything else (an
 * `or`/nested `conditional`/etc — not producible by these editors, only
 * by hand-authored or Copilot-proposed configs), signaling the caller to
 * fall back to a read-only "expression too complex for this editor"
 * notice, same pattern as parseNodeConfig's `unrecognized: true`.
 */
export function exprToConditions(expr: Expr): FilterCondition[] | null {
  if (expr.kind === "literal" && expr.value === true) return [];
  const flat = expr.kind === "logical" && expr.op === "and" ? expr.args : [expr];
  const out: FilterCondition[] = [];
  for (const node of flat) {
    if (node.kind === "comparison" && node.left.kind === "field" && node.right.kind === "literal") {
      const opMap: Record<Extract<Expr, { kind: "comparison" }>["op"], "eq" | "neq" | "gt" | "gte" | "lt" | "lte"> = {
        eq: "eq",
        neq: "neq",
        gt: "gt",
        gte: "gte",
        lt: "lt",
        lte: "lte",
      };
      out.push({ field: node.left.name, operator: opMap[node.op], value: node.right.value });
      continue;
    }
    if (node.kind === "call" && (node.fn === "is_null" || node.fn === "is_not_null") && node.args[0]?.kind === "field") {
      out.push({ field: node.args[0].name, operator: node.fn });
      continue;
    }
    if (node.kind === "call" && node.fn === "contains" && node.args[0]?.kind === "field" && node.args[1]?.kind === "literal") {
      if (node.args.length === 2) {
        out.push({ field: node.args[0].name, operator: "contains", value: node.args[1].value });
        continue;
      }
      if (node.args.length === 3 && node.args[2]?.kind === "literal" && typeof node.args[2].value === "boolean") {
        out.push({ field: node.args[0].name, operator: "contains", value: node.args[1].value, caseInsensitive: node.args[2].value });
        continue;
      }
      return null;
    }
    return null;
  }
  return out;
}

/**
 * Accepts either the current Expr shape or the pre-8b-1 legacy
 * `FilterCondition[]` shape, upcasting the latter via conditionsToExpr —
 * a parse-time upcast (not a SQL/data migration; workflow_graphs.graph is
 * JSONB, validated on every read via GraphDoc.parse(), so there's no
 * persisted schema to migrate). Existing saved workflows keep working
 * with zero data rewrite; the next save from the UI persists the new Expr
 * shape (editors always emit the new shape going forward), so legacy JSON
 * self-heals to the new shape the first time a user touches the node.
 */
const ExprOrLegacyConditions = z.union([ExprSchema, z.array(FilterCondition).transform(conditionsToExpr)]);

/**
 * Phase 8b-3 — onFailure policy for a step whose expression(s) contain a
 * fallible call (expression.ts's FALLIBLE_CALL_FNS: to_number/to_integer/
 * to_boolean/to_date/parse_date/parse_number). A "failure" is a row where
 * every argument to the fallible call is non-null but its own result is
 * null — NULL *input* is never a failure. Has no effect on a step whose
 * expression contains no fallible call.
 *   - "fail" (the semantic default when the property is ABSENT — deliberately
 *     not schema-defaulted, since no saved workflow uses computed_field yet
 *     (checked live, Phase 8b-3 Step 1) there is no backward-compatible
 *     "null" default to preserve; every op module's own logic treats
 *     `undefined` as "fail"): abort the run. The error names the step, the
 *     failing function, and the failing-row count — never raw values.
 *   - "null": failing results become NULL (this was already the only
 *     behavior before 8b-3).
 *   - "drop": rows where the fallible call failed are removed.
 *   - "quarantine": accepted by this schema, but rejected at compile time
 *     (checks.ts's checkConfig / each op's emitSql/emitMongo/applyResidual)
 *     with "quarantine requires a quarantine sink (Phase 11)" — the sink
 *     itself doesn't exist yet.
 * For `filter`, "null" and "drop" are the SAME observable behavior (a NULL
 * boolean already excludes the row under three-valued logic) — documented,
 * not a distinct code path.
 */
export const OnFailurePolicy = z.enum(["fail", "null", "drop", "quarantine"]);
export type OnFailurePolicy = z.infer<typeof OnFailurePolicy>;

/**
 * Pre-8b-1 FilterStep persisted its conditions under the key `conditions`,
 * not `expr` — the key itself was renamed, not just its value shape. A
 * plain `expr: ExprOrLegacyConditions` on the new key can only upcast the
 * *value* shape (array of FilterCondition -> Expr); it never sees data
 * still filed under the old key name, and z.object's default "strip
 * unknown keys" behavior would silently drop `conditions` and fall back
 * to `expr`'s default (`[]` -> "match everything"), turning a real
 * persisted filter into a silent no-op. This step-level preprocess
 * renames `conditions` -> `expr` (only when `expr` is absent) before the
 * object schema runs, so genuinely legacy-shaped raw JSON keeps its
 * original filtering semantics with zero data rewrite, matching Decision
 * 2's guarantee. Kept as a preprocess on the array element (in
 * TransformConfig below), not wrapped around the exported `FilterStep`
 * itself, so `FilterStep` stays a plain ZodObject usable inside
 * `TransformStep`'s discriminatedUnion.
 */
function upcastLegacyFilterKey(raw: unknown): unknown {
  if (raw && typeof raw === "object" && (raw as Record<string, unknown>).kind === "filter" && !("expr" in (raw as Record<string, unknown>)) && "conditions" in (raw as Record<string, unknown>)) {
    const { conditions, ...rest } = raw as Record<string, unknown>;
    return { ...rest, expr: conditions };
  }
  return raw;
}

export const FilterStep = z.object({
  kind: z.literal("filter"),
  /** "Keep rows where this boolean Expr is true." AND-of-comparisons is one shape it can take, not the only one, since Phase 8b-1. */
  expr: ExprOrLegacyConditions.default([]),
  /** See OnFailurePolicy's doc comment. Absent = "fail". No effect unless `expr` contains a fallible call. */
  onFailure: OnFailurePolicy.optional(),
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
  /** See OnFailurePolicy's doc comment. Absent = "fail". No effect unless `expression` contains a fallible call. */
  onFailure: OnFailurePolicy.optional(),
});
export type ComputedFieldStep = z.infer<typeof ComputedFieldStep> & { expression: Expr };

export const DropFieldsStep = z.object({
  kind: z.literal("drop_fields"),
  fields: z.array(z.string().min(1)).default([]),
});
export type DropFieldsStep = z.infer<typeof DropFieldsStep>;

/**
 * Phase 6 Block 6 — v1 aggregate-transform vocabulary. Reference digest
 * (docs/decisions.md) mapped DAX's Aggregation category onto this shape:
 * `count`/`count_field`/`count_distinct`/`sum`/`avg`/`min`/`max`. Deliberately
 * excludes `stddev`/`variance`/`median` (ledgered, not v1 — see TODO.md) and
 * has no first-class %-of-total or top-N (both parked/composition per the
 * approved digest, see TODO.md and this file's AggregateStep doc below).
 */
export const AggregateFn = z.enum(["count", "count_field", "count_distinct", "sum", "avg", "min", "max"]);
export type AggregateFn = z.infer<typeof AggregateFn>;

/**
 * `field` is null only for `fn: "count"` (COUNT(*) / Mongo $sum:1 — no
 * column operand). Every other fn requires a field name. Not enforced here
 * (permissive parse, per this file's header comment) — enforced at
 * check-time by checkConfig (checks.ts).
 * `alias` intentionally allows "" for the same autosave-transient reason as
 * FilterCondition.field/ComputedFieldStep.name above — checkConfig is where
 * emptiness/collisions actually fail.
 */
export const AggregationSpec = z.object({
  fn: AggregateFn,
  field: z.string().nullable(),
  alias: z.string(),
});
export type AggregationSpec = z.infer<typeof AggregationSpec>;

/**
 * `groupBy: []` means a whole-table aggregate (single output row) — a valid,
 * common case (e.g. "total row count"), not treated as "no grouping
 * configured yet" by any consumer.
 *
 * `having` is a boolean Expr (same unified grammar as FilterStep.expr,
 * since Phase 8b-1) rather than a parallel condition shape — but per
 * ruling 2 (docs/decisions.md), the field names it references may
 * reference ONLY an aggregation alias or a groupBy field name, never a raw
 * upstream (pre-aggregate) field; checkConfig enforces that distinction via
 * collectFieldRefs (expression.ts), since Expr's own schema can't tell the
 * difference (a `field` node is just a string).
 *
 * `%_of_total` and top-N-per-group are deliberately NOT first-class members
 * of this shape — see TODO.md's Block 6 ledger entries. Ruling 1 (docs/
 * decisions.md) found that a literal broadcast %-of-total (each row divided
 * by one whole-table total, same grain in/out) is NOT expressible via this
 * transform chain — there's no window/join primitive, and chaining can only
 * ever change or collapse grain, never broadcast a coarser total back onto
 * finer rows. What IS proven (pushdown.test.ts's "ruling 1" composition
 * case): (a) a single Aggregate step's own sibling aggregation aliases (e.g.
 * sum + count in the same output row) can be divided via a residual
 * computed_field to get an avg-shaped ratio, and (b) a second, coarser-grain
 * Aggregate step can validly chain after a pushed one as a residual
 * multi-level rollup. Neither reproduces true per-row broadcast division —
 * that gap is disclosed, not silently worked around. Top-N-per-group is
 * inexpressible until a Sort/Limit transform kind exists (parked, v1.1
 * candidate).
 */
export const AggregateStep = z.object({
  kind: z.literal("aggregate"),
  groupBy: z.array(z.string()).default([]),
  aggregations: z.array(AggregationSpec).default([]),
  having: ExprOrLegacyConditions.optional(),
  /** See OnFailurePolicy's doc comment. Absent = "fail". No effect unless `having` contains a fallible call. `groupBy`/`aggregations` never carry an Expr, so onFailure only ever applies to `having`. */
  onFailure: OnFailurePolicy.optional(),
  /**
   * Phase 7 Session 2 — Copilot Apply's cardinality-probe evidence
   * (plan.ts's PlanAggregateProbeResult), stamped onto this exact step once
   * a proposed node carrying it is applied to the real graph. Optional and
   * absent on every hand-authored/pre-Copilot node; never read as
   * validation input by checkConfig or checkDag — purely a record for
   * humans (and a future pagination pass, Block 6) of what was measured and
   * when. Never re-derived/re-probed once set; Apply writes it exactly
   * once, at apply time.
   */
  observedCount: z.number().int().nonnegative().optional(),
  probedAt: z.string().datetime().optional(),
});
export type AggregateStep = z.infer<typeof AggregateStep>;

export const TransformStep = z.discriminatedUnion("kind", [FilterStep, ComputedFieldStep, DropFieldsStep, AggregateStep]);
export type TransformStep = z.infer<typeof TransformStep>;

export const TransformConfig = z.object({
  /** Applied in array order — a later step sees the previous step's output shape (e.g. a drop_fields before a filter on a dropped field is a user-visible ordering choice, not validated here). */
  steps: z.array(z.preprocess(upcastLegacyFilterKey, TransformStep)).default([]),
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
