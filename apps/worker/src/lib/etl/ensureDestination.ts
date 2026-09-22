import {
  buildDestinationContract,
  compareContractToExisting,
  schemaFromIntrospection,
  findPersistedEntity,
  type CreateColumnSpec,
  type CreateEntityKind,
  type DestinationMappingEntry,
  type SchemaEntity,
  type SourceDestConfig,
  type SourceDialect,
  type WriteEntityRef,
} from "@nia/schemas";
import { resolveConnection } from "../resolveConnection.js";
import { getSchema } from "../introspection.js";
import { dispatchCreateEntity } from "../stagedWriteDispatch.js";
import { computeContractHash } from "./destinationContractHash.js";
import type { WorkspaceScope } from "../workspaceScope.js";

type SimpleResult = { ok: true } | { ok: false; message: string };

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
  scope: WorkspaceScope,
  actorUserId: string,
  runId: string,
): Promise<SimpleResult> {
  const mapping = destConfig.mapping!;
  const destEntity = destConfig.entity as WriteEntityRef;
  const upsertKeys = destConfig.upsertKeys!;

  const { schema: sourceSchema } = schemaFromIntrospection(sourceEntity, sourceDialect);
  const mappingEntries: DestinationMappingEntry[] = mapping.entries.map((e) => ({ from: e.from, to: e.to }));
  const keySourcePaths = mapping.entries.filter((e) => upsertKeys.includes(e.to)).map((e) => e.from);

  let contract;
  try {
    contract = buildDestinationContract({
      dialect: destDialect,
      entity: destEntity,
      sourceSchema,
      mapping: mappingEntries,
      keySourcePaths,
    });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Failed to build the destination contract." };
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
      const detail = compared.diffs.map((d) => d.detail).join("; ");
      return {
        ok: false,
        message: `Destination "${destEntity.namespace}.${destEntity.name}" already exists but doesn't match the approved contract: ${detail}`,
      };
    }
    return { ok: true };
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
  return { ok: true };
}
