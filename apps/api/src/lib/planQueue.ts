import { randomUUID } from "node:crypto";
import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { QUEUE_INTERACTIVE, PlanProposeJob, PlanProposeOutcome } from "@nia/schemas";
import { env } from "../env.js";
import { AppError } from "./appError.js";

/**
 * Phase 7 Session 3 — mirrors mappingsQueue.ts's synchronous
 * waitUntilFinished pattern exactly, not the SSE util chat/runs use. Same
 * reasoning as that file's header comment: runPlanPropose.ts resolves in a
 * single graph.invoke() call with no incremental per-node events (see its
 * own header comment), so plan_propose is a single request/response
 * outcome, same shape as mappings_propose/preview_run/schema_refresh, not
 * an incremental-events job like chat_query. (The Phase 7 plan document's
 * Session 3 wording assumed true SSE streaming for this route; that
 * doesn't match what Session 1 actually built, and Session 1 is done and
 * verified — this adapts Session 3 to the real shape rather than
 * reopening Session 1 to retrofit incremental publish events it never
 * needed.)
 *
 * Unlike mappingsQueue.ts's runProposeMappingJob (which throws on a
 * !ok outcome), this returns the full parsed PlanProposeOutcome as-is on
 * every worker-completed run — callers (copilotPropose.ts, then the
 * route, then the UI) must branch on all 5 statuses (error/no-connection/
 * refused/clarify/ok), not just success/failure. AppError is reserved for
 * genuine infra failure: the worker never returning at all, or returning
 * something that doesn't parse as a PlanProposeOutcome.
 */

const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(QUEUE_INTERACTIVE, { connection });
const queueEvents = new QueueEvents(QUEUE_INTERACTIVE, { connection });

export async function runPlanProposeJob(
  job: Omit<PlanProposeJob, "kind">,
  opts: { timeoutMs?: number } = {},
): Promise<PlanProposeOutcome> {
  const timeoutMs = opts.timeoutMs ?? env.PLAN_PROPOSE_TIMEOUT_MS;
  const jobId = randomUUID();
  const bullJob = await queue.add(
    "plan_propose",
    PlanProposeJob.parse({ kind: "plan_propose", ...job }),
    { jobId },
  );

  let result: unknown;
  try {
    result = await bullJob.waitUntilFinished(queueEvents, timeoutMs);
  } catch (err) {
    throw new AppError(
      503,
      "PLAN_PROPOSE_WORKER_UNAVAILABLE",
      `Copilot didn't respond in time: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = PlanProposeOutcome.safeParse(result);
  if (!parsed.success) {
    throw new AppError(500, "PLAN_PROPOSE_MALFORMED", "Copilot returned a malformed plan outcome.");
  }
  return parsed.data;
}
