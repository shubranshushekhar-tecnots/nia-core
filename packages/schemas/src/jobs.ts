import { z } from "zod";

/**
 * BullMQ job payloads. Two queues:
 *   "interactive" — chat, preview, checks (latency-sensitive)
 *   "heavy"       — ETL runs, backfills (throughput, chunked, resumable)
 * Separate queues so a 1M-row backfill can never starve chat.
 */

export const QUEUE_INTERACTIVE = "interactive" as const;
export const QUEUE_HEAVY = "heavy" as const;

export const ChatQueryJob = z.object({
  kind: z.literal("chat_query"),
  orgId: z.string().uuid(),
  userId: z.string().uuid(),
  conversationId: z.string().uuid(),
  message: z.string(),
  /** Compiled from canvas context scope, or resolved from @mentions. */
  connectionIds: z.array(z.string().uuid()),
});
export type ChatQueryJob = z.infer<typeof ChatQueryJob>;

export const EtlRunJob = z.object({
  kind: z.literal("etl_run"),
  orgId: z.string().uuid(),
  workflowId: z.string().uuid(),
  runId: z.string().uuid(),
  /** DAG node this job executes; edges become job dependencies. */
  nodeId: z.string(),
  /** Checkpoint cursor for resumability after worker restarts. */
  cursor: z.string().nullable(),
  chunkSize: z.number().int().positive().default(5000),
  /**
   * Required, not optional — the actor for every execution-audit row this
   * job's connector dispatch calls will write (see @nia/schemas' audit.ts).
   * Captured at enqueue time from the authenticated caller who started the
   * run; never defaulted or inferred inside the worker (the worker has no
   * live JWT to infer it from). Persisted as part of job.data, so it survives
   * checkpoint/resume unchanged — a job restarted after a worker crash still
   * attributes to the original triggering user, not whoever restarted it.
   */
  triggeredByUserId: z.string().uuid(),
});
export type EtlRunJob = z.infer<typeof EtlRunJob>;

export const CheckRunJob = z.object({
  kind: z.literal("check_run"),
  orgId: z.string().uuid(),
  workflowId: z.string().uuid(),
  checks: z.array(
    z.enum(["config", "credentials", "grants", "mappings", "dag"]),
  ),
  /**
   * Same contract as EtlRunJob.triggeredByUserId — required because the
   * "credentials" check dispatches a real /test call against a connection
   * and must be attributable, same as any other execution.
   */
  triggeredByUserId: z.string().uuid(),
});
export type CheckRunJob = z.infer<typeof CheckRunJob>;

export const InteractiveJob = z.discriminatedUnion("kind", [
  ChatQueryJob,
  CheckRunJob,
]);
export type InteractiveJob = z.infer<typeof InteractiveJob>;
