import { randomUUID } from "node:crypto";
import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { QUEUE_INTERACTIVE, ProfileRunJob, EntityProfile, type EntityRef } from "@nia/schemas";
import type { WorkspaceScope } from "./workspaceScope.js";
import { env } from "../env.js";
import { AppError } from "./appError.js";

/**
 * Express-side BullMQ producer for profile_run jobs — same module-level-
 * singleton, request/response (waitUntilFinished, not SSE) pattern as
 * schemaRefreshQueue.ts. A profile run is bounded (up to 10 paginated
 * connector dispatches, see apps/worker/src/lib/profile/sampleEntity.ts),
 * so it fits the same synchronous-await shape rather than needing a
 * chunked/resumable heavy-queue job.
 */
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(QUEUE_INTERACTIVE, { connection });
const queueEvents = new QueueEvents(QUEUE_INTERACTIVE, { connection });

export async function runProfileJob(job: {
  scope: WorkspaceScope;
  connectionId: string;
  entity: EntityRef;
  triggeredByUserId: string;
}): Promise<EntityProfile> {
  const timeoutMs = env.PROFILE_TIMEOUT_MS;
  const jobId = randomUUID();
  const bullJob = await queue.add("profile_run", ProfileRunJob.parse({ kind: "profile_run", ...job }), { jobId });

  let outcome: unknown;
  try {
    outcome = await bullJob.waitUntilFinished(queueEvents, timeoutMs);
  } catch (err) {
    throw new AppError(
      503,
      "PROFILE_WORKER_UNAVAILABLE",
      `The workflow worker did not complete this profile run within ${timeoutMs}ms. It may be offline or overloaded: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = EntityProfile.safeParse(outcome);
  if (!parsed.success) {
    throw new AppError(500, "PROFILE_MALFORMED", `Worker returned a malformed profile_run result: ${parsed.error.message}`);
  }
  return parsed.data;
}
