import type { MappingEntry } from '@nia/schemas';

/**
 * Item 3 fix (fix-chain plan): MappingEditor.tsx's `addEntry()` used to
 * hardcode `to: destFields[0] ?? ''` — always the first destination field
 * alphabetically, regardless of relevance to the new row's source field.
 * Extracted here (mirroring tableFieldState.ts's pattern) so the decision is
 * unit-testable without rendering the component.
 *
 * Returns a case-insensitive same-named match in `destFields` that isn't
 * already used by an existing entry's `to`, mirroring proposeMapping.ts's
 * own deterministic exact-match pass. Falls back to '' (unselected) when no
 * such field exists — FieldSelect already renders a disabled "Select
 * field…" placeholder for ''.
 *
 * New-table-mapping bug fix (docs/plans/new-table-mapping.md) — a brand-new
 * "+ Create new…" destination table has `destFields === []` (Item 2's
 * entity-scoping fix, now also covering the "entity doesn't resolve yet"
 * case via fieldNamesForDestinationEntity), so the same-named-match loop
 * below can never fire. Per the plan's design ("new table mapping defaults
 * to one destination column per source field, same name"), default straight
 * to `sourceField` in that case instead of leaving `to` blank — still
 * editable afterward via FieldSelect's free-text fallback for an empty
 * `destFields` list.
 */
export function defaultDestinationField(sourceField: string, destFields: string[], entries: MappingEntry[]): string {
  if (!sourceField) return '';
  const used = new Set(entries.map((e) => e.to));
  if (destFields.length === 0) return used.has(sourceField) ? '' : sourceField;
  const match = destFields.find((f) => !used.has(f) && f.toLowerCase() === sourceField.toLowerCase());
  return match ?? '';
}
