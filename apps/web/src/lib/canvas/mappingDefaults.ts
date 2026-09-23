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
 * field…" placeholder for ''. Note: once Item 2's entity-scoping fix is in
 * place, a brand-new "+ Create new…" destination table has `destFields ===
 * []`, so '' is the only possible outcome there regardless of this
 * function — this only matters when the destination table already has
 * fields.
 */
export function defaultDestinationField(sourceField: string, destFields: string[], entries: MappingEntry[]): string {
  if (!sourceField) return '';
  const used = new Set(entries.map((e) => e.to));
  const match = destFields.find((f) => !used.has(f) && f.toLowerCase() === sourceField.toLowerCase());
  return match ?? '';
}
