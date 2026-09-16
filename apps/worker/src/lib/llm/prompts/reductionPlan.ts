import { z } from "zod";
import type { ChatMessage } from "../gatewayClient.js";

/**
 * The reduction plan is a STRUCTURED OUTPUT produced BEFORE any per-source
 * query generation or dispatch — never inferred after the fact from
 * generated SQL/Mongo text via regex/keyword matching. Inferring from
 * generated query text "fails open" (an unrecognized query shape would
 * default to either over- or under-restrictive behavior); asking the model
 * to commit to a plan up front means an unsupported question is refused
 * before anything is generated or dispatched, with nothing to undo.
 *
 * Deliberately restricted to MAX/MIN/SUM/COUNT — see reduce.ts's header
 * comment for why this reduce step is never delegated to the model.
 */
export const ReductionPlan = z.discriminatedUnion("supported", [
  z.object({
    supported: z.literal(true),
    operation: z.enum(["max", "min", "sum", "count"]),
    /** The field the operation applies to, e.g. "salary". Also what reduce.ts uses to compare rows across sources for tie detection on max/min. */
    targetField: z.string(),
    /** Short natural-language label for the answer's phrasing, e.g. "the highest salary". */
    targetDescription: z.string(),
  }),
  z.object({
    supported: z.literal(false),
    /** Plain-language reason surfaced verbatim on the `refused` stream event. */
    reason: z.string(),
  }),
]);
export type ReductionPlan = z.infer<typeof ReductionPlan>;

/**
 * Deliberately classified from the question TEXT ALONE, with no schema —
 * this runs before any connection is even resolved (see multiSource/graph.ts:
 * planReduction is the very first node), so an unsupported question is
 * refused before any source is touched at all. This also matches the
 * feature's own constraint ("no field mapping"): a `targetField` like
 * "salary" is assumed to name the same field consistently across every
 * source: per-source query generation (generateQuery.ts) still validates
 * that field actually exists against that source's own real schema
 * separately, and fails that one source's pipeline (not the whole plan) if
 * it doesn't.
 */
export function buildReductionPlanPrompt(args: { question: string }): ChatMessage[] {
  const system = `You classify a question that will be answered by combining results from MULTIPLE independent data sources (a union across sources, never a join between them — no identity resolution, no field mapping — every source is assumed to expose the same field names for whatever is being asked about).

Only these reductions are supported, computed by code (never by you) across the union of all sources' rows:
- "max": finds the largest value of one field across all sources combined, and returns the FULL matching row(s) — every field on that row, not just the number. Use this for "who/which has the highest/most/largest <field>" questions, not only "what is the highest <field>".
- "min": the same as "max", but for the smallest value — also covers "who/which has the lowest/least/smallest <field>".
- "sum": the total of one numeric field across all sources combined.
- "count": the total number of rows across all sources combined.

Respond with EXACTLY one line of compact JSON, no prose, no markdown fences:
- If the question fits one of these: {"supported": true, "operation": "max"|"min"|"sum"|"count", "targetField": "<field name>", "targetDescription": "<short phrase, e.g. \\"the highest salary\\">"}
- If it does not fit (e.g. it asks for a list, a join, a comparison between named sources, an average, a percentile, or anything requiring more than one number combined across the sources): {"supported": false, "reason": "<short plain-language reason>"}

When in doubt, prefer {"supported": false} — an incorrect "supported: true" cannot be caught downstream.`;

  const user = `Question: ${args.question}`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * Validates an already-extracted JSON value against ReductionPlan's shape.
 * Soft-fails (`supported: false`) rather than throwing — an unexpected
 * shape (e.g. the model omitted a required field) is a legitimate "can't
 * do this" outcome for the caller to surface as a refusal, not a bug to
 * crash on. JSON extraction itself (fences/prose tolerance, retry-once)
 * is handled upstream by ../parseHelpers.ts's completeJson, which is what
 * produces the `parsed` value passed in here — see nodes/planReduction.ts.
 */
export function validateReductionPlanShape(parsed: unknown): ReductionPlan {
  const result = ReductionPlan.safeParse(parsed);
  if (!result.success) {
    return { supported: false, reason: `Reduction planning returned an unexpected shape: ${JSON.stringify(parsed).slice(0, 300)}` };
  }
  return result.data;
}
