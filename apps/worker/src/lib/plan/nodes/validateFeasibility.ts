import { validatePlanFeasibility, type CardinalityProbeFn, type EntityExistsLookup } from "@nia/schemas";
import { resolveConnection } from "../../resolveConnection.js";
import { getSchema } from "../../introspection.js";
import { probeCardinality } from "../probeCardinality.js";
import type { PlanStateType } from "../state.js";
import { decideRetryOrRefuse } from "./shared.js";

/** Injected-I/O check (plan.ts's validatePlanFeasibility) — entity existence + aggregate row-cap breach. */
export async function validateFeasibilityNode(state: PlanStateType): Promise<Partial<PlanStateType>> {
  const dialectByConnectionId = new Map(state.connections.map((c) => [c.id, c.dialect]));

  const entityExists: EntityExistsLookup = async (connectionId, entity) => {
    const resolved = await resolveConnection(connectionId, state.scope);
    if (!resolved.ok) return false;
    const schema = await getSchema(resolved.value);
    if (!schema.ok) return false;
    return schema.value.entities.some((e) => e.namespace === entity.namespace && e.name === entity.name);
  };

  const probeCardinalityFn: CardinalityProbeFn = async (connectionId, entity, groupBy) => {
    const dialect = dialectByConnectionId.get(connectionId);
    // No known dialect for this connection (shouldn't happen — checkConnectionsNode already confirmed every
    // referenced connectionId is visible) — can't probe. Negative signals
    // "unmeasured" to validatePlanFeasibility, which must refuse rather than
    // assume within cap (never fail open on an unmeasured aggregate).
    if (!dialect) return -1;
    return probeCardinality(connectionId, entity, groupBy, dialect, state.scope, state.userId);
  };

  const { results, probeResults } = await validatePlanFeasibility(state.plan!, {
    entityExists,
    probeCardinality: probeCardinalityFn,
  });
  const failures = results.filter((r) => r.status === "fail");
  if (failures.length === 0) {
    return { lastValidationOutcome: "ok", plan: { ...state.plan!, probeResults } };
  }

  const message = failures.map((f) => f.message).join(" ");
  // plan.ts's validatePlanFeasibility phrases every cap-related failure
  // (hard breach, headroom-margin refusal, and unmeasured-probe refusal
  // alike) with the exact substring "row cap" — used here to distinguish
  // "capacity-limit" from other feasibility failures ("partial-failure":
  // e.g. a referenced entity doesn't exist).
  const breachesCap = failures.some((f) => f.message.includes("row cap"));
  return decideRetryOrRefuse(state, message, breachesCap ? "capacity-limit" : "partial-failure");
}
