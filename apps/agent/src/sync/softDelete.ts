import type { FilterCondition } from "@nia/extract";

/**
 * Flag-column based delete detection for `deleteMode: "softDelete"` jobs
 * (docs/plans/planometry-v4-migration.md §1.2/§10, slice D2). A boolean
 * source column — read even when not in `job.mapping`, wired by
 * cli/runJobCommand.ts — marks a row as deleted when its raw driver
 * value is exactly `true`. A SQL Server `bit` column always arrives this
 * way (packages/extract/src/mssql/nativeTypeMapping.ts maps "bit" to
 * extractType "boolean", castToText: false), so no parsing/serialization
 * step belongs here — a plain identity check on the already-driver-typed
 * raw value is both correct and the cheapest possible check per row.
 */
export function isSoftDeletedRow(sourceRow: Record<string, unknown>, softDeleteColumn: string): boolean {
  return sourceRow[softDeleteColumn] === true;
}

/**
 * The replace-time exclusion filter (§1.2: "Replace: the job's normal
 * filter applies as always, and rows whose flag is true are left out").
 * Reuses the existing filter builder's `eq` operator so flagged rows are
 * never even read from the source during a replace, rather than being
 * extracted and discarded — cli/runJobCommand.ts appends this to the
 * job's resolved filter for a true replace pass only (not a `--param`
 * override run, which must still classify flagged rows as deletes).
 */
export function softDeleteExclusionFilter(softDeleteColumn: string): FilterCondition {
  return { column: softDeleteColumn, operator: "eq", value: false };
}
