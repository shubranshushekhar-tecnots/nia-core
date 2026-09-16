import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { QUEUE_INTERACTIVE, ChatQueryJob } from "@nia/schemas";
import { env } from "../env.js";

/**
 * Express-side BullMQ producer — apps/api's replacement for apps/web's old
 * lib/chat/queue.ts. Same queue, same job shape, consumed by the exact
 * same apps/worker/src/index.ts; only the producer moved. Module-level
 * singleton so route handlers reuse one connection across requests.
 */
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(QUEUE_INTERACTIVE, { connection });

export async function enqueueChatQuery(jobId: string, job: ChatQueryJob): Promise<void> {
  // Parsed here (not just passed through) so ChatQueryJob's connectionIds
  // dedup transform has already run on whatever lands in Redis, regardless
  // of what re-parses it later — same rationale as the route it replaces.
  await queue.add("chat_query", ChatQueryJob.parse(job), { jobId });
}

/**
 * Looks up a previously-enqueued job by the id POST /chat handed back to
 * the client, so GET /chat/stream can recover which conversationId (and
 * therefore which pub/sub channel — see lib/chatChannel.ts) it belongs to
 * without a separate persisted mapping table.
 */
export async function getChatJobData(jobId: string): Promise<ChatQueryJob | null> {
  const job = await queue.getJob(jobId);
  if (!job) return null;
  return ChatQueryJob.parse(job.data);
}
