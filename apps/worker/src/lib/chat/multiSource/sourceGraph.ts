import { StateGraph, START, END } from "@langchain/langgraph";
import { SourceState } from "./sourceState.js";
import { resolveConnectionNode } from "../nodes/resolveConnectionNode.js";
import { getSchemaNode } from "../nodes/getSchemaNode.js";
import { generateQueryNode } from "../nodes/generateQuery.js";
import { dispatchNode } from "../nodes/dispatchNode.js";
import { hasError } from "../nodes/shared.js";
import { withNodeSpan } from "../../observability/langfuse.js";

/**
 * Per-source pipeline: resolveConnection -> getSchema -> generateQuery ->
 * dispatch, reusing the exact same 4 nodes (and the exact same bounded
 * retry routing) as the single-source graph (../graph.ts) — see
 * nodes/shared.ts's header comment for why this is safe.
 *
 * Stops at dispatch. Unlike the single-source graph, answer generation /
 * faithfulness-checking / citation all happen ONCE at the top level, after
 * every source's dispatch has completed and been reduced (see
 * multiSource/graph.ts) — not once per source.
 */
export function buildSourceGraph() {
  const graph = new StateGraph(SourceState)
    .addNode("resolveConnection", withNodeSpan("resolveConnection", resolveConnectionNode))
    .addNode("getSchema", withNodeSpan("getSchema", getSchemaNode))
    .addNode("generateQuery", withNodeSpan("generateQuery", generateQueryNode))
    .addNode("dispatch", withNodeSpan("dispatch", dispatchNode))

    .addEdge(START, "resolveConnection")
    .addConditionalEdges("resolveConnection", (s) => (hasError(s) ? "end" : "getSchema"), {
      end: END,
      getSchema: "getSchema",
    })
    .addConditionalEdges("getSchema", (s) => (hasError(s) ? "end" : "generateQuery"), {
      end: END,
      generateQuery: "generateQuery",
    })
    .addConditionalEdges("generateQuery", (s) => (hasError(s) ? "end" : "dispatch"), {
      end: END,
      dispatch: "dispatch",
    })
    .addConditionalEdges(
      "dispatch",
      (s) => {
        switch (s.lastDispatchOutcome) {
          case "ok":
            return "end";
          case "guardrail-rejected":
            return "generateQuery";
          case "retryable":
            return "getSchema";
          default:
            return "end";
        }
      },
      { end: END, generateQuery: "generateQuery", getSchema: "getSchema" },
    );

  return graph.compile();
}
