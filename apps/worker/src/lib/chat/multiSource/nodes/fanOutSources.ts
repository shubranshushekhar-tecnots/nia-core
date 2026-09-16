import type { MultiSourceStateType, SourceResult } from "../state.js";
import { buildSourceGraph } from "../sourceGraph.js";
import { FANOUT_CONCURRENCY, SOURCE_PIPELINE_TIMEOUT_MS } from "../constants.js";
import { publishChatEvent } from "../../publish.js";

// Compiled once — stateless, per-invocation state is passed to .invoke().
const sourceGraph = buildSourceGraph();

async function runOneSource(state: MultiSourceStateType, connectionId: string): Promise<SourceResult> {
  const invocation = sourceGraph.invoke({
    jobId: state.jobId,
    conversationId: state.conversationId,
    connectionId,
    scope: state.scope,
    userId: state.userId,
    standaloneMessage: state.standaloneMessage,
    reductionPlan: state.reductionPlan,
  });

  const timeout = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), SOURCE_PIPELINE_TIMEOUT_MS);
  });

  const raced = await Promise.race([invocation, timeout]);
  if (raced === "timeout") {
    return {
      connectionId,
      ok: false,
      timedOut: true,
      error: `Source ${connectionId} did not respond within ${SOURCE_PIPELINE_TIMEOUT_MS}ms.`,
    };
  }
  if (raced.error) {
    return { connectionId, ok: false, error: raced.error };
  }
  return { connectionId, ok: true, tabularResult: raced.tabularResult };
}

/**
 * Hand-rolled bounded-concurrency fan-out — no new dependency, just a
 * simple worker-pool draining connectionIds so at most FANOUT_CONCURRENCY
 * per-source pipelines run at once, and one slow source can never hang the
 * whole request past SOURCE_PIPELINE_TIMEOUT_MS (see runOneSource).
 */
async function runBounded(state: MultiSourceStateType): Promise<SourceResult[]> {
  const queue = [...state.connectionIds];
  const results: SourceResult[] = [];
  async function worker(): Promise<void> {
    for (;;) {
      const connectionId = queue.shift();
      if (connectionId === undefined) return;
      results.push(await runOneSource(state, connectionId));
    }
  }
  const workerCount = Math.min(FANOUT_CONCURRENCY, state.connectionIds.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Partial failure = refuse, not survivor-answer: none of MAX/MIN/SUM/COUNT
 * are safe to compute from an incomplete source set — a missing source
 * could always change the true answer. Applies identically to a genuine
 * dispatch failure and a fan-out timeout (same code path here).
 */
export async function fanOutSourcesNode(state: MultiSourceStateType): Promise<Partial<MultiSourceStateType>> {
  await publishChatEvent(state.scope, state.jobId, { type: "status", stage: "executing" });
  const sourceResults = await runBounded(state);

  const failed = sourceResults.filter((r) => !r.ok);
  if (failed.length > 0) {
    const operation = state.reductionPlan?.supported ? state.reductionPlan.operation : "reduction";
    const reasons = failed.map((f) => `${f.connectionId}: ${f.error ?? "failed"}`).join("; ");
    return {
      sourceResults,
      refusal: {
        kind: "partial-failure",
        message: `${failed.length} of ${sourceResults.length} source(s) failed, so "${operation}" can't be safely computed from the rest: ${reasons}`,
      },
    };
  }
  return { sourceResults };
}
