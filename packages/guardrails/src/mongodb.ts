// MongoDB aggregation-pipeline guardrail.
//
// Read-only enforcement strategy (defense in depth — the connector
// service's Mongo user should also be provisioned with a read-only role;
// this validator is not the only boundary):
//   1. Stage allowlist: only stages that cannot mutate data or execute
//      arbitrary code are permitted.
//   2. Recursive forbidden-operator scan: catches forbidden operators
//      nested anywhere in the pipeline (e.g. inside $match, $project
//      expressions), not just at the top level.
//   3. Scope enforcement: rejects pipelines targeting collections outside
//      the connection's allowed scope, when scope is provided ($lookup /
//      $unionWith `from` targets are checked too).
//   4. $limit enforcement: caps or injects a trailing $limit stage.

import type { ConnectionScope, GuardrailResult, GuardrailValidator } from "./types.js";

const ALLOWED_STAGES = new Set([
  "$match", "$project", "$group", "$sort", "$limit", "$skip", "$unwind",
  "$lookup", "$addFields", "$set", "$count", "$facet", "$bucket",
  "$bucketAuto", "$sample", "$replaceRoot", "$replaceWith", "$unionWith",
  "$redact", "$geoNear",
]);

const FORBIDDEN_OPERATORS = new Set([
  "$out", "$merge", "$function", "$where", "$accumulator", "$expr_write",
]);

const DEFAULT_MAX_ROWS = 1000;

function collectionsReferenced(stage: Record<string, unknown>): string[] {
  const targets: string[] = [];
  const lookup = stage.$lookup as { from?: string } | undefined;
  if (lookup?.from) targets.push(lookup.from);
  const unionWith = stage.$unionWith;
  if (typeof unionWith === "string") targets.push(unionWith);
  else if (unionWith && typeof unionWith === "object" && "coll" in unionWith) {
    targets.push((unionWith as { coll: string }).coll);
  }
  return targets;
}

/** Recursively scans a pipeline stage for forbidden operator keys, at any depth. */
function scanForForbiddenOperators(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = scanForForbiddenOperators(item);
      if (hit) return hit;
    }
    return null;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (FORBIDDEN_OPERATORS.has(key)) return key;
      const hit = scanForForbiddenOperators(value);
      if (hit) return hit;
    }
  }
  return null;
}

export const validateMongoPipeline: GuardrailValidator = (
  query,
  scope: ConnectionScope,
): GuardrailResult => {
  if (query.kind !== "mongo") {
    return { ok: false, reason: `Expected a mongo query payload, got kind: ${query.kind}` };
  }

  if (scope.allowedTargets && !scope.allowedTargets.includes(query.collection)) {
    return { ok: false, reason: `Collection out of scope: ${query.collection}` };
  }

  let limitStageIdx = -1;
  for (let idx = 0; idx < query.pipeline.length; idx++) {
    const stage = query.pipeline[idx];
    if (!stage || typeof stage !== "object" || Array.isArray(stage)) {
      return { ok: false, reason: `Pipeline stage ${idx} is not an object` };
    }
    const keys = Object.keys(stage as Record<string, unknown>);
    if (keys.length !== 1) {
      return { ok: false, reason: `Pipeline stage ${idx} must have exactly one operator key` };
    }
    const stageName = keys[0]!;
    if (!ALLOWED_STAGES.has(stageName)) {
      return { ok: false, reason: `Forbidden stage: ${stageName}` };
    }
    if (stageName === "$limit") limitStageIdx = idx;

    const forbidden = scanForForbiddenOperators(stage);
    if (forbidden) {
      return { ok: false, reason: `Forbidden operator: ${forbidden}` };
    }

    for (const target of collectionsReferenced(stage as Record<string, unknown>)) {
      if (scope.allowedTargets && !scope.allowedTargets.includes(target)) {
        return { ok: false, reason: `Collection out of scope: ${target}` };
      }
    }
  }

  const pipeline = [...query.pipeline];
  if (limitStageIdx === -1) {
    pipeline.push({ $limit: DEFAULT_MAX_ROWS });
  } else {
    const stage = pipeline[limitStageIdx] as { $limit: number };
    if (typeof stage.$limit !== "number" || stage.$limit > DEFAULT_MAX_ROWS) {
      pipeline[limitStageIdx] = { $limit: DEFAULT_MAX_ROWS };
    }
  }

  return {
    ok: true,
    sanitizedQuery: { kind: "mongo", collection: query.collection, pipeline },
  };
};
