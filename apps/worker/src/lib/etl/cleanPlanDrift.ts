import {
  ADAPTER_VERSION,
  OP_CATALOG_VERSION,
  type CleanPlanDriftResult,
  type EntityRef,
  type ProfileRunJob,
} from "@nia/schemas";
import type { WorkspaceScope } from "../workspaceScope.js";
import { supabase } from "../supabaseClient.js";
import { profileEntity } from "../profile/profileEntity.js";
import { computeSchemaHash } from "../profile/signature.js";

/**
 * Phase 13, Step 6 — the run-start drift check for a CleanPlan-bound
 * transform node. Looked up once per node per run (runEtl.ts, gated on
 * `job.cursor === null`, same as the staged-write preflight it sits next
 * to). No binding row means nothing to check — most nodes never had
 * "Propose cleaning" run against them at all.
 *
 * Deliberately does NOT compare `stepsHash` against the node's current
 * TransformConfig.steps: a manual edit to a bound step removes the
 * binding synchronously (the transform-editor save path, see
 * copilotDiffApply.ts's applyCleaningPlanDiff / the graph-save site that
 * deletes the clean_plans row) — by the time this check ever runs, the
 * steps a live binding points at are exactly the steps it was proposed
 * against. `CleanPlanDriftResult`'s reason union (cleanPlan.ts) reflects
 * this: it only has schema/profile/version reasons, no "steps changed"
 * one.
 *
 * Re-profiling here always bypasses any cache by construction —
 * `profileEntity` (Phase 10) never reads `source_profiles`, it always
 * samples live and recomputes from scratch; only apps/api's profile
 * service persists/caches its result. So "recompute ... with the cache
 * bypassed" (phase13.md Step 6) falls out of profileEntity's own
 * no-persistence-in-worker shape, not anything special this file does.
 */
export async function checkCleanPlanDrift(args: {
  scope: WorkspaceScope;
  workflowId: string;
  nodeId: string;
  sourceConnectionId: string;
  entity: EntityRef;
  triggeredByUserId: string;
}): Promise<CleanPlanDriftResult> {
  const { scope, workflowId, nodeId, sourceConnectionId, entity, triggeredByUserId } = args;

  const { data: row, error } = await supabase
    .from("clean_plans")
    .select("source_schema_hash, profile_hash, op_catalog_version, adapter_version")
    .eq("workflow_id", workflowId)
    .eq("node_id", nodeId)
    .maybeSingle();

  // A read error (not "no row") is treated the same as "no binding" —
  // this check is a refusal gate, not the source of truth for whether a
  // binding exists; failing open here would only ever under-refuse a run
  // that Step 7's own apply path is responsible for keeping consistent,
  // never mask an actual drift (the query itself is unconditional select
  // by primary-key-equivalent unique columns, not a permission check).
  if (error || !row) return { ok: true };

  const profileJob: ProfileRunJob = {
    kind: "profile_run",
    scope,
    connectionId: sourceConnectionId,
    entity,
    triggeredByUserId,
  };
  const profile = await profileEntity(profileJob);
  const schemaHash = computeSchemaHash(profile.columns);

  if (schemaHash !== row.source_schema_hash) {
    return {
      ok: false,
      nodeId,
      reason: "schema-changed",
      message: `Node "${nodeId}"'s cleaning steps were proposed against a different source column shape (columns added/removed/retyped since). Refusing to run — use "Re-propose" to regenerate the cleaning plan.`,
    };
  }
  if (profile.profileHash !== row.profile_hash) {
    return {
      ok: false,
      nodeId,
      reason: "profile-changed",
      message: `Node "${nodeId}"'s cleaning steps were proposed against a different data shape (e.g. nulls/missing tokens/parseability have changed since). Refusing to run — use "Re-propose" to regenerate the cleaning plan.`,
    };
  }
  if (OP_CATALOG_VERSION !== row.op_catalog_version) {
    return {
      ok: false,
      nodeId,
      reason: "catalog-version-changed",
      message: `Node "${nodeId}"'s cleaning steps were proposed against an older op catalog version (${row.op_catalog_version}, now ${OP_CATALOG_VERSION}). Refusing to run — use "Re-propose" to regenerate the cleaning plan.`,
    };
  }
  if (ADAPTER_VERSION !== row.adapter_version) {
    return {
      ok: false,
      nodeId,
      reason: "adapter-version-changed",
      message: `Node "${nodeId}"'s cleaning steps were proposed against an older connector adapter version (${row.adapter_version}, now ${ADAPTER_VERSION}). Refusing to run — use "Re-propose" to regenerate the cleaning plan.`,
    };
  }

  return { ok: true };
}
