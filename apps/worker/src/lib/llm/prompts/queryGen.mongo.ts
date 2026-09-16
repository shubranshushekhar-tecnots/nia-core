import type { ChatMessage } from "../gatewayClient.js";
import { formatSchemaForPrompt } from "../../chat/dialect.js";
import type { IntrospectResponse } from "@nia/schemas";
import type { ReductionHint } from "./queryGen.sqlShared.js";

// This one collection/database is exactly one of several INDEPENDENT
// sources being queried in parallel and combined afterward in code (see
// multiSource/reduce.ts) — never inside this pipeline. Root cause of a
// real bug (see chat-count-diagnose.ts): faced with a question phrased
// like "...across these sources", the model sometimes tried to satisfy
// that phrase itself via "$unionWith" against another collection in this
// same database, silently inflating its own count/sum before the
// cross-source reduction ever ran. Stated explicitly so the model knows
// "these sources" refers to sibling connections it cannot see, not
// collections it can.
const SOURCE_SCOPE_NOTE =
  ' This pipeline is scoped to this one data source only — any "across these sources" phrasing in the question refers to OTHER independent connections being queried separately and combined afterward, not other collections in this database. Never use "$unionWith" or "$lookup" to simulate combining data from another source.';

function reductionInstructions(hint?: ReductionHint): string {
  if (!hint) return "";
  if (hint.operation === "max" || hint.operation === "min") {
    const sortDir = hint.operation === "max" ? -1 : 1;
    return `\n\nThis question asks for the ${hint.operation === "max" ? "highest" : "lowest"} "${hint.targetField}".${SOURCE_SCOPE_NOTE} Do NOT use a "$limit: 1" stage to pick a single document — that silently breaks ties. Instead compute the extreme value first (e.g. a "$group" with "$${hint.operation}": "$${hint.targetField}"), then "$match" the original documents down to only those whose "${hint.targetField}" equals that value, so a tie surfaces as multiple documents rather than being dropped. (Sort direction if you sort at all: ${sortDir}.)`;
  }
  // MongoDB's $group accumulator uses "$sum" for BOTH sum and count — count
  // is expressed as { $sum: 1 } (there's no separate $count accumulator).
  const expr = hint.operation === "sum" ? `"$${hint.targetField}"` : "1";
  return `\n\nThis question asks for a total (${hint.operation}) of "${hint.targetField}" across all matching documents.${SOURCE_SCOPE_NOTE} Return EXACTLY ONE document: a single "$group" with "_id: null, value: { $sum: ${expr} } }" and no other grouping key.`;
}

/**
 * MongoDB aggregation-pipeline generation prompt — see queryGen.mysql.ts's
 * header comment. Stage/operator rules here mirror (but do not replace)
 * @nia/guardrails' validateMongoPipeline allowlist.
 */
export function buildMongoQueryGenPrompt(args: {
  schema: IntrospectResponse;
  question: string;
  rejectionReason?: string;
  reductionHint?: ReductionHint;
}): ChatMessage[] {
  const system = `You translate a user's question into a single read-only MongoDB aggregation pipeline.

Rules:
- Output ONLY compact JSON: {"collection": "<name>", "pipeline": [<stages>]}. No prose, no markdown fences.
- Only use these stages: $match, $project, $group, $sort, $limit, $skip, $unwind, $lookup, $addFields, $set, $count, $facet, $bucket, $bucketAuto, $sample, $replaceRoot, $replaceWith, $unionWith, $redact, $geoNear.
- Never use $out, $merge, $function, $where, $accumulator, or anything that writes data or executes arbitrary code.
- Each stage object must have exactly one top-level operator key.
- Only reference the collection and fields listed in the schema below. Never invent names.
- If the question cannot be answered from the schema, still return your best-effort pipeline that gets as close as possible.`;

  const correction = args.rejectionReason
    ? `\n\nYour previous pipeline was rejected: "${args.rejectionReason}". Generate a different, valid, read-only pipeline that avoids this problem.`
    : "";

  const user = `Schema:\n${formatSchemaForPrompt(args.schema)}\n\nQuestion: ${args.question}${reductionInstructions(args.reductionHint)}${correction}`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
