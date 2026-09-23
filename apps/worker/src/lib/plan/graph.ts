import { StateGraph, START, END } from "@langchain/langgraph";
import { PlanState } from "./state.js";
import { resolveScopeNode } from "./nodes/resolveScope.js";
import { generatePlanNode } from "./nodes/generatePlan.js";
import { checkConnectionsNode } from "./nodes/checkConnections.js";
import { validateStructureNode } from "./nodes/validateStructure.js";
import { validateFeasibilityNode } from "./nodes/validateFeasibility.js";
import { failNode } from "./nodes/fail.js";
import { hasError } from "./nodes/shared.js";

/**
 * Plan-propose pipeline (Phase 7 Session 1):
 *   resolveScope -> generatePlan
 *     -> (error -> fail; clarifyQuestion set -> END; else -> checkConnections)
 *   checkConnections -> (error -> fail; noConnection -> END; else -> validateStructure)
 *   validateStructure -> (refused -> fail; retry -> generatePlan; ok -> validateFeasibility)
 *   validateFeasibility -> (refused -> fail; retry -> generatePlan; ok -> END)
 *   fail -> END
 *
 * Exactly one retry: generatePlanNode increments planGenAttempts every call;
 * decideRetryOrRefuse (nodes/shared.ts) caps the loop at planGenAttempts < 2,
 * same cap-1-attempt shape chat's dispatch/generateQuery retry loop uses.
 */
export function buildPlanGraph() {
  const graph = new StateGraph(PlanState)
    .addNode("resolveScope", resolveScopeNode)
    .addNode("generatePlan", generatePlanNode)
    .addNode("checkConnections", checkConnectionsNode)
    .addNode("validateStructure", validateStructureNode)
    .addNode("validateFeasibility", validateFeasibilityNode)
    .addNode("fail", failNode)

    .addEdge(START, "resolveScope")
    .addConditionalEdges("resolveScope", (s) => (hasError(s) ? "fail" : "generatePlan"), {
      fail: "fail",
      generatePlan: "generatePlan",
    })
    .addConditionalEdges(
      "generatePlan",
      (s) => (hasError(s) ? "fail" : s.clarifyQuestion !== undefined ? END : "checkConnections"),
      { fail: "fail", [END]: END, checkConnections: "checkConnections" },
    )
    .addConditionalEdges(
      "checkConnections",
      (s) => (hasError(s) ? "fail" : s.noConnection ? END : "validateStructure"),
      { fail: "fail", [END]: END, validateStructure: "validateStructure" },
    )
    .addConditionalEdges(
      "validateStructure",
      (s) => (s.lastValidationOutcome === "refused" ? "fail" : s.lastValidationOutcome === "retry" ? "generatePlan" : "validateFeasibility"),
      { fail: "fail", generatePlan: "generatePlan", validateFeasibility: "validateFeasibility" },
    )
    .addConditionalEdges(
      "validateFeasibility",
      (s) => (s.lastValidationOutcome === "refused" ? "fail" : s.lastValidationOutcome === "retry" ? "generatePlan" : END),
      { fail: "fail", generatePlan: "generatePlan", [END]: END },
    )
    .addEdge("fail", END);

  return graph.compile();
}
