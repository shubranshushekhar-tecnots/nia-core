import { z } from "zod";

/**
 * BullMQ job payloads. Two queues:
 *   "interactive" — chat, preview, checks (latency-sensitive)
 *   "heavy"       — ETL runs, backfills (throughput, chunked, resumable)
 * Separate queues so a 1M-row backfill can never starve chat.
 */

export const QUEUE_INTERACTIVE = "interactive" as const;
export const QUEUE_HEAVY = "heavy" as const;

/**
 * Mirrors apps/api's and apps/worker's WorkspaceScope TS type exactly (org-
 * scoped XOR personal/owner-scoped) — chat is the first job payload that
 * needs it, since chat now supports org-less "individual" actors (see
 * supabase/migrations/0013_chat_personal_workspace.sql). EtlRunJob/
 * CheckRunJob stay plain orgId: they remain org-only by design.
 */
export const WorkspaceScope = z.union([
  z.object({ orgId: z.string().uuid() }),
  z.object({ ownerId: z.string().uuid() }),
]);
export type WorkspaceScope = z.infer<typeof WorkspaceScope>;

export const ChatQueryJob = z.object({
  kind: z.literal("chat_query"),
  scope: WorkspaceScope,
  userId: z.string().uuid(),
  conversationId: z.string().uuid(),
  message: z.string(),
  /**
   * Compiled from canvas context scope, or resolved from @mentions.
   * Deduplicated here (source of truth), not just at the worker's dispatch
   * site — a repeated connectionId would otherwise launch two identical
   * per-source pipelines for the same source in the multi-source graph,
   * silently double-counting its contribution to SUM/COUNT. Every caller
   * that parses through this schema (currently: apps/worker/src/index.ts's
   * `InteractiveJob.parse`) inherits the dedup automatically; nothing
   * downstream needs to remember to do it itself.
   */
  connectionIds: z.array(z.string().uuid()).transform((ids) => [...new Set(ids)]),
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

/**
 * Runs the full golden-set regression suite (apps/worker/fixtures/golden/
 * chat-v1.jsonl) through the real chat pipeline — one HEAVY job, not one
 * job per question (see apps/worker/src/lib/eval/runGoldenSuite.ts's header
 * comment for why per-question fan-out isn't worth the aggregation
 * complexity). No payload fields: it always runs the current fixture file
 * against the current pipeline. Enqueued nightly by a BullMQ repeatable job
 * scheduler (index.ts) and on-demand via `pnpm eval:golden`.
 */
export const EvalRunJob = z.object({
  kind: z.literal("eval_run"),
});
export type EvalRunJob = z.infer<typeof EvalRunJob>;

export const HeavyJob = z.discriminatedUnion("kind", [EtlRunJob, EvalRunJob]);
export type HeavyJob = z.infer<typeof HeavyJob>;

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
