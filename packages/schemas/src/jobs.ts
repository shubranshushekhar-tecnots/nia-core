import { z } from "zod";
import { EntityRef } from "./nodeConfig.js";

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
 * limit. EtlRunJob (Block 5) now reuses it too: `workflow_runs` has carried
 * a nullable `owner_id` + `org_xor_owner` check constraint and an
 * owner-aware select policy since 0005_individual_workspace.sql — the DB
 * side was always ready, only the job payload and its two consumers
 * (apps/api's services/runs.ts, apps/worker's workflowRuns.ts/runEtl.ts)
 * were still hardcoded to orgId.
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
  scope: WorkspaceScope,
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

/**
 * Phase 7 Session 1 — Copilot plan-propose. Same
 * scope/workflowId/triggeredByUserId contract as ProposeMappingJob/PreviewJob
 * (the plan engine dispatches real cardinality-probe reads via dispatch(),
 * so it needs an attributable actor same as any other execution). Carries
 * `conversationId` (not a destNodeId) since a plan proposal isn't anchored
 * to one existing node — it's a free-form NL request that may add an
 * entirely new source/destination pair. `message` is the user's raw NL
 * request; the worker resolves the current GraphDoc and per-connection
 * schema context itself (see apps/worker/src/lib/plan/graph.ts), never
 * trusting client-supplied graph state for a scope-sensitive generation.
 * Explicitly on QUEUE_INTERACTIVE, not QUEUE_HEAVY — must never sit behind
 * a backfill (see Phase 7 plan's Session 1.2).
 */
export const PlanProposeJob = z.object({
  kind: z.literal("plan_propose"),
  scope: WorkspaceScope,
  userId: z.string().uuid(),
  workflowId: z.string().uuid(),
  conversationId: z.string().uuid(),
  message: z.string(),
  triggeredByUserId: z.string().uuid(),
});
export type PlanProposeJob = z.infer<typeof PlanProposeJob>;

/**
 * Phase 10 — source profiling. Carries `connectionId` + `entity` (not a
 * workflowId): profiling targets one entity on one connection directly,
 * the same connection-scoped shape as SchemaRefreshJob rather than the
 * workflow-scoped shape of PreviewJob/ProposeMappingJob — a source node
 * has no approved mapping/workflow context to resolve a target from (see
 * apps/web/src/components/canvas/NodeDrawer.tsx's Profile tab, which reads
 * `entity` straight off the source node's own persisted SourceDestConfig).
 * Same triggeredByUserId contract as every other interactive job that
 * dispatches a real read (this samples up to 10,000 real rows via
 * dispatch()). The worker computes and returns the profile only — same
 * no-persistence-in-worker shape as check_run/preview_run/schema_refresh
 * (apps/worker/src/index.ts's header comment); apps/api's connections
 * service is the one that writes the result into source_profiles, through
 * its own req.supabase.
 */
export const ProfileRunJob = z.object({
  kind: z.literal("profile_run"),
  scope: WorkspaceScope,
  connectionId: z.string().uuid(),
  entity: EntityRef,
  triggeredByUserId: z.string().uuid(),
});
export type ProfileRunJob = z.infer<typeof ProfileRunJob>;

export const InteractiveJob = z.discriminatedUnion("kind", [
  ChatQueryJob,
  CheckRunJob,
  ProposeMappingJob,
  PreviewJob,
  SchemaRefreshJob,
  PlanProposeJob,
  ProfileRunJob,
]);
export type InteractiveJob = z.infer<typeof InteractiveJob>;
