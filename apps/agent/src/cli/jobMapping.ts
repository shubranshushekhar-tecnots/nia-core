import type { CatalogTable } from "@nia/extract";
import type { SchemaColumn } from "../planometry/types.js";
import { isTypeCompatible } from "../planometry/typeCompatibility.js";

/**
 * docs/planometry/mini-nia-core.html:369, ported verbatim — the reference
 * client's case/space/underscore/dash-insensitive auto-match fallback.
 */
export const norm = (s: string): string => String(s).toLowerCase().replace(/[\s_-]/g, "");

/** One `--map source=target` CLI argument, parsed but not yet validated. */
export interface RawMappingPair {
  source: string;
  target: string;
}

export interface MappingPlan {
  pairs: RawMappingPair[];
  /** Unmapped non-key target columns — allowed, sent as null on push. */
  sentAsNull: string[];
  /** Non-empty means the mapping must be refused. */
  errors: string[];
}

export function parseMapOverrides(raw: string[]): RawMappingPair[] {
  return raw.map((entry) => {
    const eq = entry.indexOf("=");
    if (eq === -1) throw new Error(`--map must be formatted as source=target, got "${entry}"`);
    return { source: entry.slice(0, eq), target: entry.slice(eq + 1) };
  });
}

/**
 * Builds the source->target column mapping for a job: auto-match (exact
 * name first, then `norm()`) per target column, overridden by any `--map`
 * entry for that target. Refuses (via `errors`, never throws) on: two
 * sources mapped to one target, an unknown target column, a source column
 * missing from the catalog or of an excluded type, a type pair disallowed
 * by docs/plans/planometry-v4-migration.md §3, an unmapped target key
 * column, or (§3 "No default timezone") a `datetime`-typed source column
 * mapped to a `DateTime` target when `sourceTimeZone` is unset —
 * `datetime` and `datetimeoffset` SQL types both collapse to the same
 * `ExtractType`, so this can't be narrowed to "only no-offset columns" at
 * mapping time; any `datetime`->`DateTime` pair conservatively requires
 * it. Unmapped non-key target columns are reported in `sentAsNull`.
 */
export function buildMapping(
  sourceTable: CatalogTable,
  targetColumns: SchemaColumn[],
  targetKeyColumns: string[],
  overrides: RawMappingPair[],
  sourceTimeZone?: string,
): MappingPlan {
  const errors: string[] = [];

  const duplicateTargets = findDuplicateTargets(overrides);
  if (duplicateTargets.length > 0) {
    errors.push(`more than one source column is mapped to the same target column: ${duplicateTargets.join(", ")}`);
  }

  const targetNameSet = new Set(targetColumns.map((t) => t.name));
  for (const o of overrides) {
    if (!targetNameSet.has(o.target)) errors.push(`target column "${o.target}" does not exist in the target schema`);
  }

  const sourceNames = sourceTable.columns.map((c) => c.name);
  const overrideByTarget = new Map(overrides.map((o) => [o.target, o.source]));

  const pairs: RawMappingPair[] = [];
  for (const t of targetColumns) {
    const override = overrideByTarget.get(t.name);
    const auto = sourceNames.find((s) => s === t.name) ?? sourceNames.find((s) => norm(s) === norm(t.name));
    const source = override ?? auto;
    if (source) pairs.push({ source, target: t.name });
  }

  const columnByName = new Map(sourceTable.columns.map((c) => [c.name, c]));
  const excludedByName = new Map(sourceTable.excluded.map((c) => [c.name, c]));
  for (const p of pairs) {
    const sourceColumn = columnByName.get(p.source);
    if (!sourceColumn) {
      const excluded = excludedByName.get(p.source);
      errors.push(
        excluded
          ? `source column "${p.source}" is of an excluded type (${excluded.nativeType}): ${excluded.reason}`
          : `source column "${p.source}" does not exist in the catalog`,
      );
      continue;
    }
    const targetColumn = targetColumns.find((t) => t.name === p.target);
    if (!targetColumn) continue; // already reported above as an unknown target
    if (!isTypeCompatible(sourceColumn.type, targetColumn.type)) {
      errors.push(
        `source column "${p.source}" (${sourceColumn.type}) cannot be mapped to target column "${p.target}" (${targetColumn.type})`,
      );
    } else if (sourceColumn.type === "datetime" && targetColumn.type === "DateTime" && !sourceTimeZone) {
      errors.push(
        `source column "${p.source}" maps to DateTime target column "${p.target}", but the connection has no sourceTimeZone set`,
      );
    }
  }

  const mappedTargets = new Set(pairs.map((p) => p.target));
  for (const key of targetKeyColumns) {
    if (!mappedTargets.has(key)) errors.push(`target key column "${key}" must be mapped`);
  }

  const sentAsNull = targetColumns.filter((t) => !mappedTargets.has(t.name) && !targetKeyColumns.includes(t.name)).map((t) => t.name);

  return { pairs, sentAsNull, errors };
}

function findDuplicateTargets(pairs: RawMappingPair[]): string[] {
  const counts = new Map<string, number>();
  for (const p of pairs) counts.set(p.target, (counts.get(p.target) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n > 1).map(([t]) => t);
}
