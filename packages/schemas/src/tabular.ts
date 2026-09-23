import { z } from "zod";

/**
 * The normalized tabular shape — the common currency of Nia Core.
 * Every /execute across every connector service returns exactly this,
 * which is what makes citations, cross-source features, and ETL mapping possible.
 */

export const ColumnType = z.enum([
  "string",
  "number",
  "boolean",
  "date",
  "json",
  "binary",
  "unknown",
]);
export type ColumnType = z.infer<typeof ColumnType>;

export const Column = z.object({
  name: z.string(),
  type: ColumnType,
  /**
   * True when this column's name is itself ambiguous with the connector's
   * own path-flattening convention (currently only connector-mongodb: a
   * source field name containing a literal "." collides with its
   * dotted-path nesting notation). Consumers (mapping UI, write-side
   * un-flatten) must treat a degraded column as a single opaque field —
   * never split its name on "." to guess a nested shape. Defaults to
   * false for every connector that has no such ambiguity (SQL dialects).
   */
  degraded: z.boolean().optional(),
});
export type Column = z.infer<typeof Column>;

export const TabularMeta = z.object({
  /** The exact query the service executed — carried into citations and audit logs. */
  executedQuery: z.string(),
  connectionId: z.string().uuid(),
  durationMs: z.number().nonnegative(),
  rowCount: z.number().int().nonnegative(),
  /** True when the guardrail row cap trimmed the result. */
  truncated: z.boolean(),
});
export type TabularMeta = z.infer<typeof TabularMeta>;

export const TabularResult = z.object({
  columns: z.array(Column),
  rows: z.array(z.array(z.unknown())),
  meta: TabularMeta,
});
export type TabularResult = z.infer<typeof TabularResult>;
