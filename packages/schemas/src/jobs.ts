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
 * supabase/migrations/0013_chat_personal_workspace.sql). CheckRunJob
 * (Phase 5 Session 3 Task 2) reuses it for the same reason: `workflows.run`
 * is granted to "individual" in can.ts's capability matrix, and personal
 * workflows (e.g. the canvasC e2e persona) must be able to run checks too
 * — org-only would have been a real functional gap, not a deliberate scope
 * limit. EtlRunJob stays plain orgId for now: workflow *execution*
 * (Phase 6, write grants) hasn't been scoped for personal workspaces yet,
 * unlike checks/chat which are both read-only.
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
  scope: WorkspaceScope,
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

/**
 * Task 3 — AI-proposed field mappings. Deliberately carries only
 * `destNodeId`, not connection ids: the worker re-resolves the destination
 * node, its upstream source, and both connections from the workflow's own
 * GraphDoc (same resolveGraph() used by CheckRunJob's handler) rather than
 * trusting client-supplied connection ids for a scope-sensitive lookup.
 * Result is delivered via BullMQ's QueueEvents.waitUntilFinished (see
 * apps/api/src/lib/mappingsQueue.ts) — not persisted by this job at all;
 * proposals are never auto-applied (approval is a separate graph-save
 * write the user triggers explicitly).
 */
export const ProposeMappingJob = z.object({
  kind: z.literal("mappings_propose"),
  scope: WorkspaceScope,
  workflowId: z.string().uuid(),
  destNodeId: z.string(),
  triggeredByUserId: z.string().uuid(),
});
export type ProposeMappingJob = z.infer<typeof ProposeMappingJob>;

/**
 * Phase 5 Session 5 — destination-node read preview. Carries only
 * `destNodeId`, same reasoning as ProposeMappingJob: the worker re-derives
 * the upstream source (and any transform nodes on the path) from the
 * workflow's own GraphDoc via resolveGraph(), never from client-supplied
 * connection ids. Read-only by construction (see apps/worker/src/lib/
 * preview/runPreview.ts) — never touches a write path.
 */
export const PreviewJob = z.object({
  kind: z.literal("preview_run"),
  scope: WorkspaceScope,
  workflowId: z.string().uuid(),
  destNodeId: z.string(),
  triggeredByUserId: z.string().uuid(),
});
export type PreviewJob = z.infer<typeof PreviewJob>;

/**
 * Phase 5 Session 5, Block 2 — schema-refresh affordance. Carries only
 * `connectionId` (not a workflowId): this busts/re-warms ONE connection's
 * cached introspection result, independent of any particular workflow.
 * Same triggeredByUserId contract as the other interactive jobs (this
 * dispatches a real /introspect call against the connector service).
 */
export const SchemaRefreshJob = z.object({
  kind: z.literal("schema_refresh"),
  scope: WorkspaceScope,
  connectionId: z.string().uuid(),
  triggeredByUserId: z.string().uuid(),
});
export type SchemaRefreshJob = z.infer<typeof SchemaRefreshJob>;

export const InteractiveJob = z.discriminatedUnion("kind", [
  ChatQueryJob,
  CheckRunJob,
  ProposeMappingJob,
  PreviewJob,
  SchemaRefreshJob,
]);
export type InteractiveJob = z.infer<typeof InteractiveJob>;
