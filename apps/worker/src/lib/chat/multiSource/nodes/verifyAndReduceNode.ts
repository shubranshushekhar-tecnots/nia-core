import type { MultiSourceStateType } from "../state.js";
import { reduce, type ReduceWinner } from "../reduce.js";

/**
 * Deterministic, code-formatted — never LLM-phrased — description of a tied
 * winner, for the same reason reduce.ts keeps all arithmetic out of the
 * model: a tie is reported in code so its wording can't drift from what was
 * actually computed.
 */
function describeWinner(winner: ReduceWinner): string {
  const cells = winner.columns.map((c, i) => `${c.name}=${JSON.stringify(winner.row[i])}`).join(", ");
  return `[${winner.connectionId}] ${cells}`;
}

/**
 * Runs once, after every requested source has successfully dispatched
 * (fanOutSourcesNode already refused on any per-source failure/timeout, so
 * every entry in state.sourceResults here is `ok: true`). Calls the single,
 * code-only reduce() (see reduce.ts's header for why this is never
 * delegated to the model) and classifies its outcome into exactly one of
 * three routes:
 *   - reduce() itself refused (bad shape, truncation, etc.) -> `refusal`
 *   - a max/min tie (>1 winner) -> `conflictMessage`, routed by the graph
 *     to nodes/conflictNode.ts (a distinct stream event, chat.ts's
 *     `conflict` type) rather than a normal LLM-generated answer
 *   - a clean single result -> `reduceOutcome`, proceeds to buildAnswerMulti
 *
 * Only SETS state here — publishing the terminal `conflict` event is left
 * to conflictNode.ts, matching every other terminal outcome in this
 * pipeline (refuseNode/finalizeNode/failNode are the only nodes that
 * publish a terminal event).
 */
export async function verifyAndReduceNode(state: MultiSourceStateType): Promise<Partial<MultiSourceStateType>> {
  const plan = state.reductionPlan;
  if (!plan || !plan.supported) {
    // Unreachable in practice — planReductionNode already refuses an
    // unsupported plan before fan-out ever runs — but typed defensively
    // rather than asserted with `!`.
    return { refusal: { kind: "unsupported-operation", message: plan?.reason ?? "No reduction plan was set." } };
  }

  const sources = state.sourceResults.map((r) => ({ connectionId: r.connectionId, result: r.tabularResult! }));
  const outcome = reduce(plan, sources);

  if (!outcome.ok) {
    // reduce() only refuses on a data-shape problem it found in an
    // otherwise-successful source (truncation, missing field, non-numeric
    // value) — "partial-failure" is the closest existing `kind`: like a
    // dropped source, it means the true answer can't be safely computed
    // from what's available, just discovered one step later than dispatch.
    return { refusal: { kind: "partial-failure", message: outcome.reason } };
  }

  if (outcome.operation === "max" || outcome.operation === "min") {
    if (outcome.winners.length > 1) {
      const list = outcome.winners.map(describeWinner).join("; ");
      const conflictMessage = `${outcome.winners.length} rows tie for the ${outcome.operation} ${plan.targetField} (value ${outcome.value}): ${list}`;
      return { reduceOutcome: outcome, conflictMessage };
    }
  }

  return { reduceOutcome: outcome };
}
