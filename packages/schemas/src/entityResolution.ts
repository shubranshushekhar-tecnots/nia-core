import type { IntrospectResponse } from "./contract.js";
import type { EntityRef } from "./nodeConfig.js";

/**
 * Ground-truth: source nodes have no persisted entity/table selection
 * (GraphNode.config is empty for source nodes — see graph.ts's header
 * comment and nodeConfig.ts's SourceDestConfig, which carries no `entity`
 * field). The whole mapping/pushdown/preview stack instead operates on a
 * flat, deduplicated union of every entity's field names for a connection
 * (proposeMapping.ts's `uniqueFieldNames`, MappingEditor.tsx's
 * `useEntityFields`) — an approved mapping's `entries[].from` values are
 * just field *names*, never qualified by entity.
 *
 * This function bridges that gap for Phase 5's destination preview ONLY:
 * given the source connection's introspected schema and the approved
 * mapping's `from` field names, it infers which single entity the read
 * should target by finding the entity whose field set is a superset of
 * every mapped `from` field. If that's not exactly one entity, preview
 * cannot know what to read and must fail closed rather than guess.
 *
 * EXPLICIT entity selection (SourceDestConfig.entity + a drawer picker +
 * migrating checkMappings/proposeMapping/pushdown to use it) is a Phase 6
 * BLOCK-0 PREREQUISITE, not deferred polish — the ETL runner cannot infer
 * what to read the way this preview-only bridge does. See PHASE5_EXIT.md's
 * open risks and PHASE5_SESSION_NOTES.md's Session 5 entry.
 */

export type SchemaEntity = IntrospectResponse["entities"][number];

export type EntityResolutionResult =
  | { ok: true; entity: SchemaEntity }
  | { ok: false; reason: "no-fields"; message: string }
  | { ok: false; reason: "no-match"; message: string }
  | { ok: false; reason: "ambiguous"; message: string; candidates: string[] };

/**
 * `mappingFromFields` should be the approved mapping's non-empty
 * `entries[].from` values (deduplicated by the caller if it wants —
 * duplicates don't change which entities match). Pure, no I/O.
 */
export function resolveSourceEntity(
  schema: IntrospectResponse,
  mappingFromFields: string[],
): EntityResolutionResult {
  const fields = Array.from(new Set(mappingFromFields.filter((f) => f.length > 0)));
  if (fields.length === 0) {
    return { ok: false, reason: "no-fields", message: "Mapping has no field entries to infer a source table from." };
  }

  const candidates = schema.entities.filter((entity) => {
    const entityFields = new Set(entity.fields.map((f) => f.name));
    return fields.every((f) => entityFields.has(f));
  });

  if (candidates.length === 0) {
    return { ok: false, reason: "no-match", message: "Mapping fields match no single table." };
  }
  if (candidates.length > 1) {
    const names = candidates.map((e) => (e.namespace ? `${e.namespace}.${e.name}` : e.name));
    return {
      ok: false,
      reason: "ambiguous",
      message: `Mapping fields match ${candidates.length} tables: ${names.join(", ")}`,
      candidates: names,
    };
  }
  return { ok: true, entity: candidates[0]! };
}

/**
 * Phase 6 Block 0: looks up a persisted `SourceDestConfig.entity` ref against
 * a *live* introspected schema. Returns undefined (not an error) if the ref
 * doesn't match any entity in the current schema — e.g. the table was
 * renamed/dropped upstream since the ref was saved — so callers fall back to
 * the flat-union/inference behavior rather than hard-failing on drift.
 */
export function findPersistedEntity(schema: IntrospectResponse, ref: EntityRef): SchemaEntity | undefined {
  return schema.entities.find((e) => e.namespace === ref.namespace && e.name === ref.name);
}

/**
 * Phase 6 Block 0: the field-name list a mapping/preview/check consumer
 * should use for a source. When `entity` is given and still resolves against
 * the live schema, this scopes strictly to that one entity's fields — no
 * more flat union losing table context. Otherwise (no persisted entity, or
 * it no longer resolves) it falls back to the pre-Block-0 flat, deduplicated
 * union across every entity, preserving existing behavior for graphs saved
 * before `entity` existed.
 */
export function fieldNamesForSource(schema: IntrospectResponse, entity?: EntityRef): string[] {
  if (entity) {
    const resolved = findPersistedEntity(schema, entity);
    if (resolved) return resolved.fields.map((f) => f.name);
  }
  return Array.from(new Set(schema.entities.flatMap((e) => e.fields.map((f) => f.name))));
}
