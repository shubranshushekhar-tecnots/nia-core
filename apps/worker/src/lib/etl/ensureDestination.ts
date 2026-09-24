import {
  buildDestinationContract,
  compareContractToExisting,
  compileTransformOutputSchema,
  schemaFromIntrospection,
  findPersistedEntity,
  type CreateColumnSpec,
  type CreateEntityKind,
  type DestinationContract,
  type DestinationMappingEntry,
  type NiaSchema,
  type SchemaEntity,
  type SourceDestConfig,
  type SourceDialect,
  type TransformStep,
  type WriteEntityRef,
} from "@nia/schemas";
import { resolveConnection } from "../resolveConnection.js";
import { getSchema } from "../introspection.js";
import { dispatchCreateEntity } from "../stagedWriteDispatch.js";
import { computeContractHash } from "./destinationContractHash.js";
import type { WorkspaceScope } from "@nia/db";

/**
 * `created` (orphaned-destination-table lifecycle fix): true only when this
 * call actually issued the entity's CREATE (dispatchCreateEntity's own
 * `created` flag) — never true for a pre-existing entity that merely
 * compared clean via compareContractToExisting. runEtl.ts uses this to
 * decide whether to durably record the entity in stagingRegistry as
 * something THIS run may need to drop on a later terminal failure — a
 * pre-existing destination must never be touched by that drop path.
 */
type SimpleResult = { ok: true; created: boolean } | { ok: false; message: string };
type ContractResult =
  | { ok: true; contract: DestinationContract; sourceSchema: NiaSchema; rawSourceSchema: NiaSchema }
  | { ok: false; message: string };

/**
 * Schema layer, Part 5 — the pure, no-I/O contract-building step factored
 * out of ensureDestination() below so runEtl.ts can call it unconditionally
 * (every chunk, every write mode), not just staged-mode-first-chunk. Same
 * "build once, compare hash if one's already approved" logic
 * ensureDestination() always had; ensureDestination() now just calls this
 * instead of duplicating it.
 *
 * The contract is built from the pipeline's OUTPUT schema, not the raw
 * source schema: `transformSteps` (every TransformStep on the path from
 * source to destination, in execution order, across however many
 * transform nodes sit between them — see runEtl.ts's call site) is run
 * through compileTransformOutputSchema before the mapping is applied, so
 * an Aggregate alias or a computed_field's cleaned type (e.g. `amount`
 * after `to_number` is decimal, not text) resolves to its REAL output
 * type, not the pre-transform source column's type. A mapped column that
 * still can't be resolved against that output schema (a genuinely unknown
 * field, not a transform-produced one) fails here, naming it — same "never
 * guess" bar as buildDestinationContract's own mapping-resolution check
 * below. No more "unresolved" soft-fallback: Part 4's v1 gap (contract
 * building only ever saw the raw source schema, so an Aggregate-sourced
 * mapping could never resolve) is what this function now fixes, not a
 * case to degrade gracefully around.
 *
 * Returns `sourceSchema` (the pipeline's OUTPUT schema, post-transform)
 * alongside the contract so callers that need to reason about which
 * fields the mapping had available to it — e.g. runEtl.ts's unknown-
 * field-policy check — compare against the same schema the contract was
 * actually built from, not the raw pre-transform source entity.
 *
 * Also returns `rawSourceSchema` (the PRE-transform introspected/inferred
 * source schema) — needed by conformance.ts's skip-if-already-conforming
 * check: a mapped column's `contract.niaType` is always the POST-transform
 * kind (by construction, since `sourceSchema` above feeds
 * buildDestinationContract), so it can never itself tell you whether a
 * transform actually changed that column's type. Comparing
 * `rawSourceSchema.fields[col.sourcePath]?.type.kind` against
 * `contract.columns[i].niaType.kind` is the only way to tell a genuine
 * passthrough column (no cast needed, Part 5's "skip it" clause) apart
 * from one a transform step actually produced or changed.
 */
export function buildRuntimeContract(
  destDialect: SourceDialect,
  sourceEntity: SchemaEntity,
  sourceDialect: SourceDialect,
  destConfig: SourceDestConfig,
  transformSteps: TransformStep[],
): ContractResult {
  const mapping = destConfig.mapping!;
  const destEntity = destConfig.entity as WriteEntityRef;
  const upsertKeys = destConfig.upsertKeys ?? [];

  const { schema: rawSourceSchema } = schemaFromIntrospection(sourceEntity, sourceDialect);
  const outputSchemaResult = compileTransformOutputSchema(rawSourceSchema, transformSteps);
  if (!outputSchemaResult.ok) {
    return { ok: false, message: `Destination contract: ${outputSchemaResult.error}` };
  }
  const sourceSchema = outputSchemaResult.schema;
  const mappingEntries: DestinationMappingEntry[] = mapping.entries.map((e) => ({ from: e.from, to: e.to }));
  const keySourcePaths = mapping.entries.filter((e) => upsertKeys.includes(e.to)).map((e) => e.from);

  let contract: DestinationContract;
  try {
    contract = buildDestinationContract({
      dialect: destDialect,
      entity: destEntity,
      sourceSchema,
      mapping: mappingEntries,
      keySourcePaths,
    });
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Failed to build the destination contract.",
    };
  }

  if (destConfig.contractHash) {
    const freshHash = computeContractHash(contract);
    if (freshHash !== destConfig.contractHash) {
      return {
        ok: false,
        message: `Destination contract drift: the approved contract hash no longer matches the current mapping/source schema for "${destEntity.namespace}.${destEntity.name}". Re-review and re-approve the mapping before running again.`,
      };
    }
  }

  return { ok: true, contract, sourceSchema, rawSourceSchema };
}

/**
 * Schema layer, Part 4 — the destination-contract counterpart to
 * stagedWrite.ts's `runPreflight`/`ensureStaging`. Called once per run
 * (job.cursor === null), staged mode only (mirrors runPreflight/
 * ensureStaging's own gate — see runEtl.ts's call site), BEFORE
 * runPreflight: the plan doc's Part 4 says entity creation "runs in
 * preflight, before staging," and runPreflight's `has_table_privilege`
 * check already requires the destination to exist, so creation has to
 * happen first. Disclosed scope narrowing: direct-mode destinations are
 * unchanged by Part 4 — they still require a pre-existing table, same as
 * before Phase 11. Auto-creation/comparison is staged-mode only for v1.
 *
 * Builds one DestinationContract from the resolved source entity + the
 * approved mapping, then either:
 *   - the destination entity doesn't exist yet: creates it via the signed
 *     /create-entity path (dispatchCreateEntity), driven entirely by the
 *     contract's columns/keys — never guesses a shape beyond what the
 *     contract says.
 *   - it exists: reads its structure back and refuses on any diff
 *     (compareContractToExisting) — never ALTERs/drops.
 * Either way, if `destConfig.contractHash` is already set (approved by a
 * prior run or CleanPlan binding), the freshly-built contract's hash is
 * compared against it first and a mismatch refuses the run outright —
 * see nodeConfig.ts's `contractHash` doc comment. Nothing here writes
 * `contractHash` back (disclosed Part 4 scope narrowing, same file).
 */
export async function ensureDestination(
  destConnectionId: string,
  destDialect: SourceDialect,
  sourceEntity: SchemaEntity,
  sourceDialect: SourceDialect,
  destConfig: SourceDestConfig,
  transformSteps: TransformStep[],
  scope: WorkspaceScope,
  actorUserId: string,
  runId: string,
): Promise<SimpleResult> {
  const destEntity = destConfig.entity as WriteEntityRef;

  const built = buildRuntimeContract(destDialect, sourceEntity, sourceDialect, destConfig, transformSteps);
  if (!built.ok) return { ok: false, message: built.message };
  const contract = built.contract;

  const keyColumns = contract.columns.filter((c) => c.isKey).map((c) => c.destinationName);
  if (keyColumns.length === 0) {
    return {
      ok: false,
      message: `Destination contract for "${destEntity.namespace}.${destEntity.name}" has no key columns matching the selected upsert key(s).`,
    };
  }

  const resolvedDest = await resolveConnection(destConnectionId, scope);
  if (!resolvedDest.ok) return { ok: false, message: `Destination connection: ${resolvedDest.error.message}` };
  const destSchema = await getSchema(resolvedDest.value);
  if (!destSchema.ok) return { ok: false, message: `Destination schema: ${destSchema.error.message}` };

  const existing = findPersistedEntity(destSchema.value, destEntity);
  if (existing) {
    const compared = compareContractToExisting(contract, existing);
    if (!compared.ok) {
      const detail = compared.diffs
        .map((d) => (d.alterStatement ? `${d.detail} (fix: ${d.alterStatement})` : d.detail))
        .join("; ");
      return {
        ok: false,
        message: `Destination "${destEntity.namespace}.${destEntity.name}" already exists but doesn't match the approved contract: ${detail}`,
      };
    }
    return { ok: true, created: false };
  }

  const kind: CreateEntityKind = destDialect === "mongo" ? "collection" : "table";
  const columns: CreateColumnSpec[] = contract.columns.map((c) => ({
    name: c.destinationName,
    nativeType: c.nativeType,
    nullable: c.nullable,
  }));

  const created = await dispatchCreateEntity(
    destConnectionId,
    { kind, entity: destEntity, columns, keys: keyColumns, runId },
    scope,
    actorUserId,
  );
  if (!created.ok) return { ok: false, message: `Destination creation failed: ${created.error.message}` };
  return { ok: true, created: created.value.created };
}
