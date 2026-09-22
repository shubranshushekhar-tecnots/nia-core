import type { NiaSchema, NiaType } from "./niaType.js";
import { getDialectAdapter, type Fidelity } from "./niaAdapters.js";
import type { SourceDialect } from "./ops/types.js";
import { normalizeFieldName } from "./niaInference.js";

/**
 * Schema layer, Part 4 — destination contract. One contract per
 * destination node: the target entity, and per mapped column its source
 * path, normalized destination name, NiaType, dialect-native type
 * (niaAdapters.ts's fromNiaType()), fidelity, and key flag, plus a
 * nested-field strategy and an unknown-field policy. See
 * docs/plans/schema-layer.md's Part 4 section.
 *
 * Deviation (disclosed): built from the mapping's *raw introspected/
 * inferred* source NiaTypes (schemaFromIntrospection for SQL sources,
 * niaInference.ts's inferSchemaFromColumns for Mongo/file sources) — not
 * the fully-compiled post-transform pushdown output schema. Part 3's
 * outputSchema()/typeOfExpr machinery has no runtime call site yet (no
 * consumer ever asked a compiled step for its output NiaSchema — see the
 * Part 3 follow-up entries in docs/plans/schema-layer.md), and wiring one
 * up would mean restructuring runEtl.ts's compile-timing model, which is
 * out of Part 4's scope. A node with transform steps that change a
 * column's type (e.g. a `cast`) gets a contract computed against the
 * PRE-transform source type for that column today; Part 5's conformance
 * step (which casts to the contract type) still makes the end-to-end
 * behavior correct, it just means the contract's own `niaType`/
 * `nativeType` for a transformed column can look more permissive than the
 * step that actually produces it. Fine for v1; worth tightening once
 * outputSchema() has a real runtime consumer.
 */

export type NestedFieldStrategy = "json" | "flatten";
export type UnknownFieldPolicy = "count" | "fail";

export interface DestinationContractColumn {
  sourcePath: string;
  destinationName: string;
  niaType: NiaType;
  nativeType: string;
  fidelity: Fidelity;
  isKey: boolean;
  /**
   * Whether the created column allows NULL — the source field's own
   * `NiaField.nullable` (niaType.ts), except a key column is always
   * forced non-nullable regardless of the source's own nullability
   * (matching SQL PRIMARY KEY / UNIQUE semantics; Mongo's unique index
   * doesn't reject nulls the same way, but forcing it here keeps one
   * consistent contract rule across dialects rather than a per-dialect
   * exception). Feeds CreateColumnSpec.nullable at creation time
   * (ensureDestination.ts) — added alongside the rest of this file's
   * fields since `buildDestinationContract` otherwise had nothing to put
   * there.
   */
  nullable: boolean;
  /**
   * Metadata only (disclosed deviation): the mapping model is still a
   * flat 1:1 `{from, to}` per column (nodeConfig.ts's MappingEntry) —
   * there is no multi-column-per-source-field mechanism for this field to
   * drive. A nested (object/array) NiaType column always gets "json" here
   * (matching niaAdapters.ts's fromNiaType() default: nested -> one native
   * JSON column). Actual flattening is achieved by adding an upstream
   * `flatten` TransformStep (Part 3), which turns the nested field into
   * several flat mapped columns before the contract is even built, not by
   * a runtime effect of this flag. Kept on the type for forward
   * compatibility / UI display (Part 4's "JSON/flatten toggle per nested
   * field" preview bullet), with no behavior behind "flatten" yet.
   */
  nestedFieldStrategy: NestedFieldStrategy;
}

export interface DestinationContract {
  dialect: SourceDialect;
  entity: { namespace: string; name: string };
  columns: DestinationContractColumn[];
  /**
   * Disclosed deviation: stored for forward documentation only. The
   * current write path (runEtl.ts / stagedWrite.ts) only ever selects and
   * writes the columns present in the approved mapping — a source field
   * that isn't mapped is never read at all, so there is no live
   * enforcement point for "fail" vs "count" yet. Live counting of
   * out-of-contract fields is Part 5 scope ("Fields not in the contract
   * follow the unknown-field policy and are counted in the run result").
   */
  unknownFieldPolicy: UnknownFieldPolicy;
}

export interface DestinationMappingEntry {
  from: string;
  to: string;
}

export interface BuildDestinationContractInput {
  dialect: SourceDialect;
  entity: { namespace: string; name: string };
  /** The source's NiaSchema — from niaAdapters.ts's schemaFromIntrospection() for a declared SQL source, or niaInference.ts's inferSchemaFromColumns() for an inferred Mongo/file source. */
  sourceSchema: NiaSchema;
  /** The already-approved, human-picked mapping (nodeConfig.ts's FieldMapping.entries) — `from` must be a key of sourceSchema.fields. */
  mapping: DestinationMappingEntry[];
  /** Source field names (mapping's `from` side) that back the destination's upsert key(s). */
  keySourcePaths: string[];
  unknownFieldPolicy?: UnknownFieldPolicy;
}

/**
 * Builds one DestinationContract from an approved mapping. Never guesses:
 * a mapping entry whose `from` isn't in `sourceSchema.fields` fails
 * naming the field, same "fail naming the column, never guess" bar Part 3
 * set for outputSchema().
 *
 * Names: destination names run through niaInference.ts's
 * normalizeFieldName() (Part 2's shared normalizer — lowercase
 * alnum/underscore only, so it already satisfies Mongo's "no '.', no
 * leading '$'" rule for free), with a per-contract `seen` set so
 * collisions across the WHOLE column set get a numeric suffix, not just
 * within one source entity. The mapping UI already normalizes/shows `to`
 * names at proposal time (Part 2) — re-running it here is a defense-in-
 * depth pass for hand-edited mappings and manual (non-UI) pipelines, not
 * a re-decision; a `to` name that was already normalized simply round-
 * trips unchanged.
 */
export function buildDestinationContract(input: BuildDestinationContractInput): DestinationContract {
  const adapter = getDialectAdapter(input.dialect);
  const keySet = new Set(input.keySourcePaths);
  const seen = new Set<string>();
  const columns: DestinationContractColumn[] = input.mapping.map((entry) => {
    const field = input.sourceSchema.fields[entry.from];
    if (!field) {
      throw new Error(`destination contract: mapped source field "${entry.from}" was not found in the source schema`);
    }
    const destinationName = normalizeFieldName(entry.to, seen);
    const { nativeType, fidelity } = adapter.fromNiaType(field.type);
    const isKey = keySet.has(entry.from);
    return {
      sourcePath: entry.from,
      destinationName,
      niaType: field.type,
      nativeType,
      fidelity,
      isKey,
      nullable: isKey ? false : field.nullable,
      nestedFieldStrategy: "json",
    };
  });
  return {
    dialect: input.dialect,
    entity: input.entity,
    columns,
    unknownFieldPolicy: input.unknownFieldPolicy ?? "count",
  };
}

export interface ContractDiff {
  kind: "missing-column" | "type-mismatch";
  column: string;
  detail: string;
}

export type ContractCompareResult = { ok: true } | { ok: false; diffs: ContractDiff[] };

/**
 * Existing targets: read their structure back (IntrospectResponse's
 * per-entity fields, from the connector's /introspect) and compare
 * against the contract. Refuses (returns diffs, never throws/ALTERs) on
 * any missing column or native-type mismatch. Case-insensitive type
 * comparison — every dialect adapter emits its native type strings in a
 * consistent case, but IntrospectResponse's `type` field is whatever the
 * driver/information_schema reports verbatim (e.g. Postgres always
 * lowercases; MySQL's driver can vary) — comparing case-insensitively
 * avoids a false-positive refusal over pure casing. An existing column
 * NOT in the contract is not a diff here (Part 4 never fails on extra
 * existing columns; only Part 5's unknown-field policy is about columns
 * the RUN produces that aren't in the contract, a different direction).
 */
export function compareContractToExisting(
  contract: DestinationContract,
  existing: { fields: { name: string; type: string }[] },
): ContractCompareResult {
  const existingByName = new Map(existing.fields.map((f) => [f.name, f.type]));
  const diffs: ContractDiff[] = [];
  for (const col of contract.columns) {
    const existingType = existingByName.get(col.destinationName);
    if (existingType === undefined) {
      diffs.push({
        kind: "missing-column",
        column: col.destinationName,
        detail: `contract expects column "${col.destinationName}" (${col.nativeType}) but the existing target has no such column`,
      });
      continue;
    }
    if (existingType.trim().toLowerCase() !== col.nativeType.trim().toLowerCase()) {
      diffs.push({
        kind: "type-mismatch",
        column: col.destinationName,
        detail: `column "${col.destinationName}" is "${existingType}" on the existing target but the contract expects "${col.nativeType}"`,
      });
    }
  }
  return diffs.length === 0 ? { ok: true } : { ok: false, diffs };
}

/**
 * Crypto-free canonicalization for the contract hash — same constraint as
 * cleanPlan.ts's canonicalizeStepsForHash (this package ships to
 * apps/web's browser bundle, so no node:crypto here). Callers (apps/api's
 * apply path, apps/worker's run-start drift recompute) pass
 * `JSON.stringify(canonicalizeContractForHash(contract))` into their own
 * thin `createHash("sha256")` wrapper, same split as cleanPlan.ts's
 * stepsHash/sourceSchemaHash/profileHash. "The contract's hash joins the
 * CleanPlan bindings" (Part 4 plan bullet) — see cleanPlan.ts's
 * CleanPlanRecord.contractHash; for manual (non-CleanPlan) pipelines it's
 * stored directly on the destination node's SourceDestConfig instead
 * (nodeConfig.ts's contractHash field).
 */
export function canonicalizeContractForHash(contract: DestinationContract): unknown {
  return {
    dialect: contract.dialect,
    entity: contract.entity,
    unknownFieldPolicy: contract.unknownFieldPolicy,
    columns: [...contract.columns]
      .map((c) => ({
        sourcePath: c.sourcePath,
        destinationName: c.destinationName,
        niaType: c.niaType,
        nativeType: c.nativeType,
        isKey: c.isKey,
        nullable: c.nullable,
        nestedFieldStrategy: c.nestedFieldStrategy,
      }))
      .sort((a, b) => a.destinationName.localeCompare(b.destinationName)),
  };
}
