import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Plan, type IntrospectResponse } from "@nia/schemas";
import { completeJson, JsonExtractionError } from "../../llm/parseHelpers.js";
import { buildPlanGenPrompt } from "../../llm/prompts/planGen.js";
import { resolveConnection } from "../../resolveConnection.js";
import { getSchema } from "../../introspection.js";
import type { PlanStateType } from "../state.js";

const GeneratePlanResponse = z.object({
  clarifyQuestion: z.string().nullable().optional(),
  plan: Plan.nullable().optional(),
});

/**
 * Models reliably emit `"connectionId": null` on transform nodes (no
 * connection applies) despite the prompt saying "source/destination only" —
 * they treat the field as always-present-but-nullable rather than omittable.
 * PlanNode.connectionId is `.optional()`, not `.nullable()` (transform nodes
 * genuinely have no connection, so there's nothing to default to) — strip
 * an explicit null here, at the LLM boundary, rather than loosening the
 * canonical schema to accept a value that's never meaningful downstream.
 * Same "tolerate LLM quirks at the call site" precedent as
 * parseHelpers.ts's stripFences/extractBalancedJsonBlock.
 *
 * Deliberately scoped to `type: "transform"` nodes only. A source/
 * destination node genuinely needs a connectionId — if the model emits
 * `null` there, that's a real generation defect, not a quirk to paper
 * over, and must surface as a loud Zod validation error (missing required
 * uuid) rather than get silently normalized into a connectionless source.
 */
export function stripNullConnectionIds(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const plan = (raw as Record<string, unknown>).plan;
  if (typeof plan !== "object" || plan === null) return raw;
  const nodes = (plan as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) return raw;
  for (const node of nodes) {
    if (
      node &&
      typeof node === "object" &&
      (node as Record<string, unknown>).type === "transform" &&
      (node as Record<string, unknown>).connectionId === null
    ) {
      delete (node as Record<string, unknown>).connectionId;
    }
  }
  return raw;
}

/**
 * LLM call producing a Plan (or a clarify question) — structured-JSON output
 * via completeJson (same fence-stripping/salvage/one-retry mechanism chat's
 * generateQuery.ts uses). Best-effort fetches each candidate connection's
 * introspected schema for prompt context — a schema-fetch failure just
 * means that connection's entities aren't listed in the prompt, never a
 * hard node failure (same degrade-on-catch precedent
 * runWorkflowChecks.ts's buildMappingsCheck uses).
 *
 * JsonExtractionError / a response that fails schema validation are
 * TERMINAL `error`s, not fed into the structure/feasibility retry loop —
 * same precedent chat's generateQuery.ts sets for unparseable LLM output.
 * The one-retry loop (decideRetryOrRefuse, nodes/shared.ts) is specifically
 * for well-formed-but-invalid/infeasible plans, not generation-format
 * failures.
 *
 * Every branch explicitly clears the fields it doesn't set (plan/
 * clarifyQuestion/feedback/lastValidationOutcome/refusalKind/noConnection) —
 * LangGraph's reducer is last-write-wins per returned key, so stale state
 * from a prior retry iteration would otherwise leak through.
 */
export async function generatePlanNode(state: PlanStateType): Promise<Partial<PlanStateType>> {
  const schemasByConnectionId = new Map<string, IntrospectResponse>();
  for (const conn of state.connections) {
    try {
      const resolved = await resolveConnection(conn.id, state.scope);
      if (!resolved.ok) continue;
      const schema = await getSchema(resolved.value);
      if (schema.ok) schemasByConnectionId.set(conn.id, schema.value);
    } catch {
      // Best-effort prompt context only.
    }
  }

  const messages = buildPlanGenPrompt({
    message: state.rawMessage,
    existingGraph: state.existingGraph!,
    connections: state.connections,
    schemasByConnectionId,
    feedback: state.feedback,
  });

  let parsed: unknown;
  try {
    // temperature: 0 — Phase 13 gate: eval:golden:plan flakiness was traced
    // to LLM sampling variance, not model drift (the resolved gateway model
    // is a fixed snapshot, not a rolling alias — see docs/decisions.md's
    // Phase 13 gate entry). Plan generation should be deterministic given
    // identical input; pinned here only, not gateway-wide.
    parsed = await completeJson(messages, { node: "generatePlan", temperature: 0 });
  } catch (err) {
    if (!(err instanceof JsonExtractionError)) throw err;
    return { error: `Plan generation returned unparseable JSON: ${err.message}` };
  }

  const result = GeneratePlanResponse.safeParse(stripNullConnectionIds(parsed));
  if (!result.success) {
    return { error: `Plan generation returned a response that didn't match the expected shape: ${result.error.message}` };
  }

  if (result.data.clarifyQuestion) {
    return {
      clarifyQuestion: result.data.clarifyQuestion,
      plan: undefined,
      feedback: undefined,
      planGenAttempts: state.planGenAttempts + 1,
      lastValidationOutcome: undefined,
      refusalKind: undefined,
      noConnection: false,
    };
  }

  if (!result.data.plan) {
    return { error: "Plan generation returned neither a clarifyQuestion nor a plan." };
  }

  // Defense in depth only — a truly blank id is nonsensical and can't be
  // referenced by any edge the model could have meaningfully generated
  // against it, so assigning a synthetic one here can't break an edge ref.
  for (const node of result.data.plan.nodes) {
    if (node.id.trim() === "") node.id = `plan-${randomUUID()}`;
  }

  return {
    plan: result.data.plan,
    clarifyQuestion: undefined,
    feedback: undefined,
    planGenAttempts: state.planGenAttempts + 1,
    lastValidationOutcome: undefined,
    refusalKind: undefined,
    noConnection: false,
  };
}
