import type { ChatMessage } from "../gatewayClient.js";
import type { ReduceOutcome } from "../../chat/multiSource/reduce.js";
import type { ReductionPlan } from "./reductionPlan.js";

/**
 * Renders an ALREADY-COMPUTED ReduceOutcome as plain facts for the model to
 * phrase into prose — the model never sees raw rows or does any arithmetic
 * itself here (see reduce.ts's header for why reduction is code-only). This
 * node only ever runs with a single winner (a tie routes to conflictNode.ts
 * instead — see verifyAndReduceNode.ts), so there is exactly one row to
 * describe for max/min.
 */
export function formatOutcome(outcome: Extract<ReduceOutcome, { ok: true }>): string {
  // Narrowed via the distinguishing property ("winners" vs
  // "contributingSources"), not `operation === "max" | "min"` — TS can't
  // use `operation` as a discriminant here because each branch's type for
  // it is itself a 2-value union ("max"|"min" / "sum"|"count"), not a
  // single literal, so an equality check against it doesn't narrow.
  if ("winners" in outcome) {
    const winner = outcome.winners[0]!;
    const cells = winner.columns.map((c, i) => `${c.name}=${JSON.stringify(winner.row[i])}`).join(", ");
    return `Computed ${outcome.operation} = ${outcome.value}, from source ${winner.connectionId}, row: ${cells}`;
  }
  return `Computed ${outcome.operation} = ${outcome.value}, across ${outcome.contributingSources.length} source(s): ${outcome.contributingSources.join(", ")}`;
}

export function buildAnswerGenMultiPrompt(args: {
  question: string;
  plan: Extract<ReductionPlan, { supported: true }>;
  outcome: Extract<ReduceOutcome, { ok: true }>;
  rejectionReason?: string;
  previousAnswer?: string;
}): ChatMessage[] {
  const correction = args.rejectionReason
    ? `\n\nYour previous answer was flagged as not fully supported by the computed result: "${args.rejectionReason}". Revise it so it states only the computed value below.${
        args.previousAnswer ? ` Previous answer: "${args.previousAnswer}"` : ""
      }`
    : "";

  const system = `You answer the user's question using ONLY the already-computed result below (it was computed in code, not by you — never recompute or second-guess it). State the value plainly and cite which source(s) it came from. Be concise. Do not fabricate or infer anything beyond what's given.`;

  const user = `Question: ${args.question}\n\nThis question asked for ${args.plan.targetDescription} (${args.plan.operation} of "${args.plan.targetField}") across multiple sources.\n\n${formatOutcome(args.outcome)}${correction}`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
