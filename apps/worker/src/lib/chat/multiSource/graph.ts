import { StateGraph, START, END } from "@langchain/langgraph";
import { MultiSourceState, type MultiSourceStateType } from "./state.js";
import { planReductionNode } from "./nodes/planReduction.js";
import { fanOutSourcesNode } from "./nodes/fanOutSources.js";
import { verifyAndReduceNode } from "./nodes/verifyAndReduceNode.js";
import { buildAnswerMultiNode } from "./nodes/buildAnswerMultiNode.js";
import { faithfulnessMultiNode } from "./nodes/faithfulnessMultiNode.js";
import { finalizeMultiNode } from "./nodes/finalizeMultiNode.js";
import { conflictNode } from "./nodes/conflictNode.js";
import { refuseNode } from "./nodes/refuseNode.js";
import { failNode } from "./nodes/failNode.js";
import { hasError } from "../nodes/shared.js";
import { withNodeSpan } from "../../observability/langfuse.js";

/**
 * Multi-source chat pipeline:
 *   planReduction -> (unsupported -> refuse) -> (supported -> fanOutSources)
 *   fanOutSources -> (any source failed/timed out -> refuse) -> (all ok -> verifyAndReduce)
 *   verifyAndReduce -> (reduce() refused -> refuse)
 *                    -> (max/min tie, >1 winner -> conflict)
 *                    -> (single clean result -> buildAnswerMulti)
 *   buildAnswerMulti -> faithfulnessMulti
 *     -> (conflict & !retried -> buildAnswerMulti again with reason)
 *     -> (ok, or conflict already retried -> finalizeMulti)
 *   Any unexpected `error` at any step -> fail (defensive only — every
 *   expected failure mode is routed via `refusal`/refuseNode instead, see
 *   each node's own header comment)
 *
 * Deliberately mirrors ../graph.ts's shape and retry discipline, widened
 * for the extra pre-fan-out planning step and the three-way refuse/
 * conflict/success split that single-source dispatch doesn't need.
 */
function isRefused(state: MultiSourceStateType): boolean {
  return state.refusal !== undefined;
}

export function buildMultiSourceGraph() {
  const graph = new StateGraph(MultiSourceState)
    .addNode("planReduction", withNodeSpan("planReduction", planReductionNode))
    .addNode("fanOutSources", withNodeSpan("fanOutSources", fanOutSourcesNode))
    .addNode("verifyAndReduce", withNodeSpan("verifyAndReduce", verifyAndReduceNode))
    .addNode("buildAnswerMulti", withNodeSpan("buildAnswerMulti", buildAnswerMultiNode))
    .addNode("faithfulnessMulti", withNodeSpan("faithfulnessMulti", faithfulnessMultiNode))
    .addNode("finalizeMulti", withNodeSpan("finalizeMulti", finalizeMultiNode))
    .addNode("conflict", withNodeSpan("conflict", conflictNode))
    .addNode("refuse", withNodeSpan("refuse", refuseNode))
    .addNode("fail", withNodeSpan("fail", failNode))

    .addEdge(START, "planReduction")
    .addConditionalEdges(
      "planReduction",
      (s) => (hasError(s) ? "fail" : isRefused(s) ? "refuse" : "fanOutSources"),
      { fail: "fail", refuse: "refuse", fanOutSources: "fanOutSources" },
    )
    .addConditionalEdges(
      "fanOutSources",
      (s) => (hasError(s) ? "fail" : isRefused(s) ? "refuse" : "verifyAndReduce"),
      { fail: "fail", refuse: "refuse", verifyAndReduce: "verifyAndReduce" },
    )
    .addConditionalEdges(
      "verifyAndReduce",
      (s) => (hasError(s) ? "fail" : isRefused(s) ? "refuse" : s.conflictMessage !== undefined ? "conflict" : "buildAnswerMulti"),
      { fail: "fail", refuse: "refuse", conflict: "conflict", buildAnswerMulti: "buildAnswerMulti" },
    )
    .addConditionalEdges("buildAnswerMulti", (s) => (hasError(s) ? "fail" : "faithfulnessMulti"), {
      fail: "fail",
      faithfulnessMulti: "faithfulnessMulti",
    })
    .addConditionalEdges(
      "faithfulnessMulti",
      (s) => (hasError(s) ? "fail" : s.faithfulnessOutcome === "conflict-retry" ? "buildAnswerMulti" : "finalizeMulti"),
      { fail: "fail", buildAnswerMulti: "buildAnswerMulti", finalizeMulti: "finalizeMulti" },
    )
    .addEdge("finalizeMulti", END)
    .addEdge("conflict", END)
    .addEdge("refuse", END)
    .addEdge("fail", END);

  return graph.compile();
}
