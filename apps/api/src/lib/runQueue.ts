import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { QUEUE_HEAVY, EtlRunJob } from "@nia/schemas";
import { env } from "../env.js";

/**
 * Express-side BullMQ producer for the heavy queue's etl_run jobs — same
 * queue apps/worker/src/index.ts's `heavy` Worker consumes and the same one
 * runEtl.ts self-enqueues onto for subsequent chunks. Module-level singleton
 * so route handlers reuse one connection across requests, same shape as
 * lib/chatQueue.ts.
 */
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(QUEUE_HEAVY, { connection });

/**
 * The first chunk's BullMQ jobId is the runId itself — every subsequent
 * chunk (enqueued by runEtl.ts) gets a fresh random jobId, since BullMQ
 * jobIds must be unique per job, not per run. runId (not jobId) is the
 * stable identifier the client polls/streams against, via
 * workflow_runs.id and lib/runChannel.ts's channel/replay keys.
 */
export async function enqueueEtlRun(job: EtlRunJob): Promise<void> {
  await queue.add("etl_run", EtlRunJob.parse(job), { jobId: job.runId });
}

/**
 * Looks up the first chunk's job by runId so GET /:id/run/stream can recover
 * which org this run belongs to (for the ownership check) without a
 * separate persisted mapping — same rationale as chatQueue.ts's
 * getChatJobData. Once the run has advanced past its first chunk, this job
 * is gone (each chunk replaces the previous under a new jobId), but that's
 * fine: `workflow_runs` (written by the worker on the first chunk) is the
 * durable record a reconnecting client falls back to be routed via the same
 * scope check — the job lookup here only needs to succeed long enough for a
 * client to open the initial stream.
 */
export async function getEtlRunJobData(runId: string): Promise<EtlRunJob | null> {
  const job = await queue.getJob(runId);
  if (!job) return null;
  return EtlRunJob.parse(job.data);
}
