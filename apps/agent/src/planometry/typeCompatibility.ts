import type { ExtractType } from "@nia/extract";
import type { ColumnType } from "./types.js";

/**
 * docs/plans/planometry-v4-migration.md §3 "Values": which target
 * `ColumnType`s a given source `ExtractType` may be mapped to. The
 * source side is already collapsed to this 5-type system by
 * `@nia/extract`'s catalog introspection (packages/extract/src/mssql/
 * nativeTypeMapping.ts) before anything in apps/agent ever sees a SQL
 * Server native type name — binary-family types never reach here at
 * all, since introspection excludes them from the catalog outright.
 * Exported standalone (not inlined into cli/jobMapping.ts) so a later
 * slice's `planometry/formatForTarget.ts` (A3) can reuse the exact same
 * table for its own compatibility check immediately before each push.
 */
export const TYPE_COMPATIBILITY: Record<ExtractType, ColumnType[]> = {
  date: ["Date", "Text"],
  datetime: ["DateTime", "Date", "Text"],
  text: ["Text"],
  boolean: ["Boolean", "Text"],
  number: ["Number", "Text"],
};

export function isTypeCompatible(sourceType: ExtractType, targetType: ColumnType): boolean {
  return TYPE_COMPATIBILITY[sourceType].includes(targetType);
}
