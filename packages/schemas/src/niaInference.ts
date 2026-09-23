import type { ColumnStats } from "./profile.js";
import { join, type NiaField, type NiaSchema, type NiaType } from "./niaType.js";

/**
 * Schema layer, Part 2 — inferred NiaSchema from a profiler sample
 * (Mongo sources and file uploads; SQL sources use niaAdapters.ts's
 * schemaFromIntrospection instead, since those have a declared schema).
 * See docs/plans/schema-layer.md.
 *
 * connector-mongodb already flattens nested objects into dotted-path
 * columns and JSON.stringifies arrays before ColumnStats ever sees them
 * (services/connector-mongodb/src/flatten.ts) — so "every field path,
 * including nested ones" is already present in ColumnStats[] as dotted
 * names; this module's job is (a) joining each path's per-shape observed
 * counts into one NiaType leaf, and (b) un-flattening those dotted paths
 * back into a nested NiaTypeObject tree.
 */

/** The shape vocabulary apps/worker/src/lib/profile/stats.ts's classifyNiaShape() counts into ColumnStats.observedTypeCounts. */
function shapeToNiaType(shape: string): NiaType {
  switch (shape) {
    case "string":
      return { kind: "string" };
    case "integer":
      return { kind: "integer" };
    case "float":
      return { kind: "float" };
    case "boolean":
      return { kind: "boolean" };
    // BSON Date (the only "date" shape classifyNiaShape ever emits, since
    // it only fires on real JS Date instances) always carries a full
    // instant, and connector-mongodb reads it back as UTC — utc, not a
    // bare calendar date.
    case "date":
      return { kind: "timestamp", tz: "utc" };
    default:
      // "other" — e.g. a Buffer/Binary leaf, or any shape this module
      // doesn't yet special-case. json is the universal escape hatch,
      // same precedent as niaType.ts's own fallback().
      return { kind: "json" };
  }
}

/** One column's NiaField: join every non-null observed shape's NiaType together, nullable/presence from nullCount vs sampleCount. */
function leafFieldFromColumn(col: ColumnStats): NiaField {
  const shapes = Object.keys(col.observedTypeCounts).filter((k) => k !== "null" && (col.observedTypeCounts[k] ?? 0) > 0);
  const nullCount = col.observedTypeCounts.null ?? 0;
  const nullable = nullCount > 0 || col.sampleCount === 0;
  const presence = col.sampleCount > 0 ? (col.sampleCount - nullCount) / col.sampleCount : 0;

  if (shapes.length === 0) {
    // Only nulls (or no non-null-shape samples at all) observed for this path.
    return { type: { kind: "json" }, nullable: true, presence };
  }

  let type: NiaType = shapeToNiaType(shapes[0]!);
  for (const shape of shapes.slice(1)) {
    type = join(type, shapeToNiaType(shape)).type;
  }
  return { type, nullable, presence };
}

interface TreeNode {
  leaf: ColumnStats | null;
  children: Map<string, TreeNode>;
}

function getOrCreateChild(node: TreeNode, key: string): TreeNode {
  let child = node.children.get(key);
  if (!child) {
    child = { leaf: null, children: new Map() };
    node.children.set(key, child);
  }
  return child;
}

/**
 * Builds a NiaField for one tree node. A node with no children is a plain
 * leaf. A node with children (a dotted-path prefix, e.g. "a" when "a.b"
 * and "a.c" exist) becomes a NiaTypeObject; nullable/presence for that
 * object are approximations, since flatten.ts fills every leaf under a
 * wholly-absent nested object with null rather than recording the
 * object's own absence separately: nullable is true if ANY child is
 * nullable (the subtree is sometimes entirely missing), presence is the
 * MIN across children (the object can't be "more present" than its
 * least-present member).
 *
 * If a node has BOTH a direct leaf column (e.g. a bare "a" column) AND
 * children ("a.b"), that's a real shape conflict — some documents have
 * "a" as a scalar, others as a nested object — and is resolved via the
 * same join() used everywhere else, landing on "json" (degraded).
 */
function fieldFromNode(node: TreeNode): NiaField {
  if (node.children.size === 0) {
    return leafFieldFromColumn(node.leaf!);
  }

  const fields: Record<string, NiaField> = {};
  let anyNullable = false;
  let minPresence = 1;
  for (const [key, child] of [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const field = fieldFromNode(child);
    fields[key] = field;
    if (field.nullable) anyNullable = true;
    if (field.presence !== undefined) minPresence = Math.min(minPresence, field.presence);
  }
  const objectField: NiaField = { type: { kind: "object", fields }, nullable: anyNullable, presence: minPresence };

  if (node.leaf === null) return objectField;

  // Conflict: this path is both a scalar leaf and an object prefix.
  const leafField = leafFieldFromColumn(node.leaf);
  const joined = join(objectField.type, leafField.type);
  return {
    type: joined.type,
    nullable: objectField.nullable || leafField.nullable,
    presence: Math.min(objectField.presence ?? 1, leafField.presence ?? 1),
  };
}

/**
 * Builds an inferred NiaSchema from a profiler sample's ColumnStats[],
 * un-flattening dotted-path column names (Mongo's connector-level
 * flattening — see this file's header comment) back into nested
 * NiaTypeObject fields.
 */
export function inferSchemaFromColumns(columns: ColumnStats[]): NiaSchema {
  const root: TreeNode = { leaf: null, children: new Map() };
  for (const col of columns) {
    const segments = col.name.split(".");
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      node = getOrCreateChild(node, segment);
    }
    const last = segments[segments.length - 1]!;
    const leafNode = getOrCreateChild(node, last);
    leafNode.leaf = col;
  }

  const fields: Record<string, NiaField> = {};
  for (const [key, child] of root.children) {
    fields[key] = fieldFromNode(child);
  }
  return { fields };
}

/**
 * Schema layer, Part 4 preview — a deterministic destination-name
 * normalizer, pulled forward from Part 4 only far enough to cover the
 * plan's Tests section, which pairs inference with "name normalization
 * with one collision" in a single test. Full per-destination treatment
 * (dialect-specific allowed characters, reserved words) is Part 4 scope;
 * this is the minimal shared shape: lowercase alnum/underscore, collapsed
 * separators, truncated + hash-suffixed when over maxLength, and a
 * numeric suffix on collision against `seen` (mutated in place, same
 * pattern as a running column-name registry during destination-contract
 * building).
 */
export interface NormalizeNameOptions {
  maxLength?: number;
}

/** Small deterministic non-cryptographic hash (packages/schemas ships to the browser too — no node:crypto here), used only to keep truncated names from colliding with each other, not for anything security-sensitive. */
function shortHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).slice(0, 6);
}

export function normalizeFieldName(raw: string, seen: Set<string>, options: NormalizeNameOptions = {}): string {
  const maxLength = options.maxLength ?? 63;
  let base = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (base.length === 0) base = "field";
  if (base.length > maxLength) {
    const hash = shortHash(raw);
    base = `${base.slice(0, Math.max(1, maxLength - hash.length - 1))}_${hash}`;
  }

  let candidate = base;
  let suffix = 2;
  while (seen.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  seen.add(candidate);
  return candidate;
}
