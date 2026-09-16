import { StateGraph, START, END } from "@langchain/langgraph";
import { ChatState } from "./state.js";
import { rewriteNode } from "./nodes/rewrite.js";
import { resolveConnectionNode } from "./nodes/resolveConnectionNode.js";
import { getSchemaNode } from "./nodes/getSchemaNode.js";
import { generateQueryNode } from "./nodes/generateQuery.js";
import { dispatchNode } from "./nodes/dispatchNode.js";
import { buildAnswerNode } from "./nodes/buildAnswer.js";
import { faithfulnessNode } from "./nodes/faithfulness.js";
import { finalizeNode } from "./nodes/finalize.js";
import { failNode } from "./nodes/fail.js";
import { hasError } from "./nodes/shared.js";
import { withNodeSpan } from "../observability/langfuse.js";

/**
 * Single-source chat pipeline:
 *   rewrite -> resolveConnection -> getSchema -> generateQuery -> dispatch
 *     -> (guardrail-rejected & !retried -> generateQuery again with reason)
 *     -> (retryable failure & !reintrospected -> getSchema again, fresh schema)
 *     -> (ok -> buildAnswer)
 *   buildAnswer -> faithfulness
 *     -> (conflict & !retried -> buildAnswer again with reason)
 *     -> (ok, or conflict already retried -> finalize)
 *   Any terminal error -> fail
 *
 * Early nodes (rewrite/resolveConnection/getSchema/generateQuery) can only
 * fail by setting `error` directly (no retry loop of their own) — routed
 * straight to `fail`.
 */
export function buildChatGraph() {
  const graph = new StateGraph(ChatState)
    .addNode("rewrite", withNodeSpan("rewrite", rewriteNode))
    .addNode("resolveConnection", withNodeSpan("resolveConnection", resolveConnectionNode))
    .addNode("getSchema", withNodeSpan("getSchema", getSchemaNode))
    .addNode("generateQuery", withNodeSpan("generateQuery", generateQueryNode))
    .addNode("dispatch", withNodeSpan("dispatch", dispatchNode))
    .addNode("buildAnswer", withNodeSpan("buildAnswer", buildAnswerNode))
    .addNode("faithfulness", withNodeSpan("faithfulness", faithfulnessNode))
    .addNode("finalize", withNodeSpan("finalize", finalizeNode))
    .addNode("fail", withNodeSpan("fail", failNode))

    .addEdge(START, "rewrite")
    .addConditionalEdges("rewrite", (s) => (hasError(s) ? "fail" : "resolveConnection"), {
      fail: "fail",
      resolveConnection: "resolveConnection",
    })
    .addConditionalEdges("resolveConnection", (s) => (hasError(s) ? "fail" : "getSchema"), {
      fail: "fail",
      getSchema: "getSchema",
    })
    .addConditionalEdges("getSchema", (s) => (hasError(s) ? "fail" : "generateQuery"), {
      fail: "fail",
      generateQuery: "generateQuery",
    })
    .addConditionalEdges("generateQuery", (s) => (hasError(s) ? "fail" : "dispatch"), {
      fail: "fail",
      dispatch: "dispatch",
    })
    .addConditionalEdges(
      "dispatch",
      (s) => {
        switch (s.lastDispatchOutcome) {
          case "ok":
            return "buildAnswer";
          case "guardrail-rejected":
            return "generateQuery";
          case "retryable":
            return "getSchema";
          default:
            return "fail";
        }
      },
      { buildAnswer: "buildAnswer", generateQuery: "generateQuery", getSchema: "getSchema", fail: "fail" },
    )
    .addConditionalEdges("buildAnswer", (s) => (hasError(s) ? "fail" : "faithfulness"), {
      fail: "fail",
      faithfulness: "faithfulness",
    })
    .addConditionalEdges(
      "faithfulness",
      (s) => (s.faithfulnessOutcome === "conflict-retry" ? "buildAnswer" : "finalize"),
      { buildAnswer: "buildAnswer", finalize: "finalize" },
    )
    .addEdge("finalize", END)
    .addEdge("fail", END);

  return graph.compile();
}
