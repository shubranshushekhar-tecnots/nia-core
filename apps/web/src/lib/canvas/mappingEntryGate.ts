/**
 * Pure decision logic for MappingEditor.tsx's "schema race" fix (ledgered in
 * PHASE5_SESSION_NOTES.md: a fast user/test could commit a mapping entry
 * with an empty-string field value by clicking "+ Entry" before the
 * relevant schema query resolved, since an empty field list from
 * useEntityFields is indistinguishable from "still loading" vs.
 * "genuinely has zero fields"). Extracted so this is unit-testable without
 * rendering the component, same rationale as tableFieldState.ts.
 */
export function isAddMappingEntryDisabled(args: { sourceFieldsLoading: boolean; destFieldsLoading: boolean }): boolean {
  return args.sourceFieldsLoading || args.destFieldsLoading;
}
