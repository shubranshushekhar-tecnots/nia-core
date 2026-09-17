import type { ChatQueryJob } from "@nia/schemas";
import { buildChatGraph } from "./graph.js";
import { buildMultiSourceGraph } from "./multiSource/graph.js";
import { MAX_SOURCES } from "./multiSource/constants.js";
import { publishChatEvent } from "./publish.js";
import { persistAssistantMessage } from "./persistMessage.js";
import { runInTrace, flushLangfuse } from "../observability/langfuse.js";

/**
 * The chat pipeline's one real entry point — the exact logic index.ts's
 * "interactive" worker runs for every `chat_query` job (0/1/2+ connectionIds
 * branching, single- vs multi-source graph selection, trace/flush wiring,
 * terminal-event/persistence guarantees). Extracted out of index.ts so the
 * golden-set eval runner (lib/eval/runGoldenSuite.ts) can execute the exact
 * same production code path per question instead of a re-implementation
 * that could drift from what actually ships — see Phase 4 Task 3.
 *
 * Takes jobId as an explicit param rather than reading job.id itself so
 * both call sites (the real BullMQ worker, and the eval runner's synthetic
 * per-question jobIds) can supply it.
 */

// Compiled once per process — see index.ts's original header comment for
// why recompiling per call would be wasteful (the graphs are stateless).
const chatGraph = buildChatGraph();
const multiSourceGraph = buildMultiSourceGraph();

export type ChatQueryResult =
  | { status: "error"; reason: "no-connection-selected" }
  | { status: "refused"; reason: "capacity-limit" | string }
  | { status: "error"; error: string }
  | {
      status: "ok";
      faithful: boolean;
      // Surfaced for the golden-set eval runner to distinguish a plain
      // first-try faithful answer from one that only shipped after the
      // faithfulness retry loop ran its course (conflict-final) — see
      // runGoldenSuite.ts's "answer" case and applyFaithfulnessVerdict.
      faithfulnessOutcome: "ok" | "conflict-retry" | "conflict-final" | undefined;
      answerGenAttempts: number;
    }
  | { status: "conflict" };

export async function runChatQuery(payload: ChatQueryJob, jobId: string): Promise<ChatQueryResult> {
  const { connectionIds, scope } = payload;

  if (connectionIds.length === 0) {
    const message = "No connection selected — mention a connection to run this query against.";
    await publishChatEvent(scope, jobId, { type: "error", message });
    await persistAssistantMessage({
      scope,
      conversationId: payload.conversationId,
      content: message,
      citations: [],
      status: "error",
    });
    return { status: "error", reason: "no-connection-selected" };
  }

  if (connectionIds.length > MAX_SOURCES) {
    const message = `You selected ${connectionIds.length} sources — this exceeds the maximum of ${MAX_SOURCES} sources per query. Select ${MAX_SOURCES} or fewer.`;
    await publishChatEvent(scope, jobId, { type: "refused", kind: "capacity-limit", message });
    await persistAssistantMessage({
      scope,
      conversationId: payload.conversationId,
      content: message,
      citations: [],
      status: "refused",
    });
    return { status: "refused", reason: "capacity-limit" };
  }

  if (connectionIds.length === 1) {
    try {
      const finalState = await runInTrace(
        {
          jobId,
          scope,
          conversationId: payload.conversationId,
          mode: "single",
          connectionHandles: connectionIds,
        },
        () =>
          chatGraph.invoke({
            jobId,
            userId: payload.userId,
            conversationId: payload.conversationId,
            connectionId: connectionIds[0],
            scope,
            rawMessage: payload.message,
          }),
      );

      const meta = finalState.tabularResult?.meta;
      await persistAssistantMessage({
        scope,
        conversationId: payload.conversationId,
        content: finalState.error ?? finalState.answer ?? "",
        citations: meta
          ? [{ connectionId: meta.connectionId, executedQuery: meta.executedQuery, rowCount: meta.rowCount, truncated: meta.truncated }]
          : [],
        status: finalState.error ? "error" : "complete",
      });

      return finalState.error
        ? { status: "error", error: finalState.error }
        : {
            status: "ok",
            faithful: finalState.faithful === true,
            faithfulnessOutcome: finalState.faithfulnessOutcome,
            answerGenAttempts: finalState.answerGenAttempts,
          };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Chat pipeline crashed unexpectedly.";
      await publishChatEvent(scope, jobId, { type: "error", message });
      await persistAssistantMessage({
        scope,
        conversationId: payload.conversationId,
        content: message,
        citations: [],
        status: "error",
      });
      throw err;
    } finally {
      await flushLangfuse();
    }
  }

  try {
    const finalState = await runInTrace(
      {
        jobId,
        scope,
        conversationId: payload.conversationId,
        mode: "multi",
        connectionHandles: connectionIds,
      },
      () =>
        multiSourceGraph.invoke({
          jobId,
          userId: payload.userId,
          conversationId: payload.conversationId,
          connectionIds,
          scope,
          rawMessage: payload.message,
          standaloneMessage: payload.message,
        }),
    );

    const citations = finalState.sourceResults
      .filter((r) => r.ok && r.tabularResult)
      .map((r) => {
        const meta = r.tabularResult!.meta;
        return { connectionId: meta.connectionId, executedQuery: meta.executedQuery, rowCount: meta.rowCount, truncated: meta.truncated };
      });

    if (finalState.error) {
      await persistAssistantMessage({
        scope,
        conversationId: payload.conversationId,
        content: finalState.error,
        citations: [],
        status: "error",
      });
      return { status: "error", error: finalState.error };
    }
    if (finalState.refusal) {
      await persistAssistantMessage({
        scope,
        conversationId: payload.conversationId,
        content: finalState.refusal.message,
        citations: [],
        status: "refused",
      });
      return { status: "refused", reason: finalState.refusal.kind };
    }
    if (finalState.conflictMessage) {
      await persistAssistantMessage({
        scope,
        conversationId: payload.conversationId,
        content: finalState.conflictMessage,
        citations,
        status: "conflict",
      });
      return { status: "conflict" };
    }
    await persistAssistantMessage({
      scope,
      conversationId: payload.conversationId,
      content: finalState.answer ?? "",
      citations,
      status: "complete",
    });
    return {
      status: "ok",
      faithful: finalState.faithful === true,
      faithfulnessOutcome: finalState.faithfulnessOutcome,
      answerGenAttempts: finalState.answerGenAttempts,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Chat pipeline crashed unexpectedly.";
    await publishChatEvent(scope, jobId, { type: "error", message });
    await persistAssistantMessage({
      scope,
      conversationId: payload.conversationId,
      content: message,
      citations: [],
      status: "error",
    });
    throw err;
  } finally {
    await flushLangfuse();
  }
}
