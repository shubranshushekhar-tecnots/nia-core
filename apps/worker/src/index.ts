import { Worker, Queue, type Job } from "bullmq";
import { Redis } from "ioredis";
import {
  QUEUE_INTERACTIVE,
  QUEUE_HEAVY,
  InteractiveJob,
  HeavyJob,
} from "@nia/schemas";
import { runChatQuery } from "./lib/chat/runChatQuery.js";
import { runWorkflowChecks } from "./lib/checks/runWorkflowChecks.js";
import { proposeMapping } from "./lib/mappings/proposeMapping.js";
import { runPreview } from "./lib/preview/runPreview.js";
import { refreshSchema } from "./lib/schema/refreshSchema.js";
import { runGoldenSuite } from "./lib/eval/runGoldenSuite.js";
import { registerNightlyEvalSchedule } from "./lib/eval/schedule.js";
import { shutdownLangfuse } from "./lib/observability/langfuse.js";
import { runEtl } from "./lib/etl/runEtl.js";
import { runPlanPropose } from "./lib/plan/runPlanPropose.js";
import { profileEntity } from "./lib/profile/profileEntity.js";
import { registerStagingSweepSchedule } from "./lib/etl/stagingSweepSchedule.js";
import { sweepStaleStaging } from "./lib/etl/stagingSweeper.js";

/**
 * Nia worker — the execution spine.
 * Consumes Redis/BullMQ jobs enqueued by the Next.js BFF.
 * Never serves HTTP. Never holds a connector credential directly — those
 * stay Vault-resolved inside each connector service (see
 * services/connector-mysql/src/pool-manager.ts), reached only via
 * connectionId/vaultRef references carried in job payloads.
 *
 * It does get a scoped service_role Supabase client (not built yet — no
 * real dispatch call site exists until the workflow runner lands), the same
 * precedent workflow_runs already documents: system-authored writes with no
 * live user JWT (workflow_runs itself, and the execution-audit chokepoint's
 * log_execution_audit RPC) use service_role, trusted because the worker only
 * ever acts on jobs whose payload already carries an explicit
 * triggeredByUserId/userId — never inferred, never a general-purpose
 * credential store. Express, by contrast, never gets service_role
 * (apps/api/src/env.ts) — it only ever holds the caller's own JWT.
 *
 * Two queues:
 *  - interactive: chat pipeline (LangGraph), previews, checks
 *  - heavy: ETL / backfills (chunked, checkpointed, resumable), and the
 *    nightly golden-set eval run (lib/eval/runGoldenSuite.ts) — it's a
 *    real-pipeline batch job like ETL, not latency-sensitive, so it belongs
 *    on this queue rather than interactive.
 */

const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null, // required by BullMQ
});

const interactive = new Worker(
  QUEUE_INTERACTIVE,
  async (job: Job) => {
    const payload = InteractiveJob.parse(job.data);
    switch (payload.kind) {
      case "chat_query": {
        console.log(
          `[interactive] chat_query for ${"orgId" in payload.scope ? `org ${payload.scope.orgId}` : `owner ${payload.scope.ownerId}`}`,
        );
        // job.id is always set here — apps/api's enqueueChatQuery always
        // passes an explicit jobId at queue.add() time (never BullMQ's
        // auto-generated default), so this is never undefined in practice.
        return runChatQuery(payload, job.id!);
      }
      case "check_run":
        // Wired (Phase 5 Session 3 Task 2) — lib/checks/runWorkflowChecks.ts.
        // The workflowId -> connectionId mapping this case's stub comment
        // used to say didn't exist now does: GraphNode.connectionId (see
        // packages/schemas/src/graph.ts) carries it per source/destination
        // node, read straight off the workflow's persisted GraphDoc. This
        // handler only computes results, never persists them — see
        // runWorkflowChecks.ts's header comment for why the worker's
        // service_role client structurally cannot call
        // public.record_check_run itself (no auth.uid()); the Express route
        // that enqueues this job is the one that persists, through its own
        // req.supabase.
        console.log(`[interactive] check_run for workflow ${payload.workflowId}`);
        return await runWorkflowChecks(payload);
      case "mappings_propose":
        // Task 3 — proposeMapping.ts owns resolving the graph/connections
        // and calling the LLM gateway; this handler only computes the
        // proposal, it never persists it (see proposeMapping.ts's header
        // comment — approval is a separate, explicit graph-save write).
        console.log(`[interactive] mappings_propose for workflow ${payload.workflowId} dest ${payload.destNodeId}`);
        return await proposeMapping(payload.workflowId, payload.destNodeId, payload.scope);
      case "preview_run":
        // Block 1 (Phase 5 Session 5) — runPreview.ts owns path-walking,
        // entity resolution, check-result reuse, pushdown compilation, and
        // the read-shape assertion before dispatch. This handler only
        // computes the preview result, it never persists anything — same
        // no-persistence shape as check_run/mappings_propose.
        console.log(`[interactive] preview_run for workflow ${payload.workflowId} dest ${payload.destNodeId}`);
        return await runPreview(payload);
      case "schema_refresh":
        // Block 2 (Phase 5 Session 5) — busts + re-warms this worker's own
        // introspection cache; see refreshSchema.ts's header comment for
        // why this is a separate half from apps/api's own cache-bust.
        console.log(`[interactive] schema_refresh for connection ${payload.connectionId}`);
        return await refreshSchema(payload);
      case "plan_propose":
        // Phase 7 Session 1 — runPlanPropose.ts owns the LangGraph
        // plan-propose pipeline (resolveScope -> generatePlan ->
        // checkConnections -> validateStructure -> validateFeasibility),
        // same no-persistence-in-index.ts shape as every other case: this
        // handler only computes the proposed Plan (or a refusal/clarify/
        // no-connection outcome), it never persists a graph mutation —
        // that's Session 2's Apply route, a separate explicit write.
        console.log(`[interactive] plan_propose for workflow ${payload.workflowId}`);
        return await runPlanPropose(payload, job.id!);
      case "profile_run":
        // Phase 10 — profileEntity.ts owns connection/schema/entity
        // resolution, keyset head/tail sampling, and stats/signature/hash
        // computation; this handler only computes the EntityProfile, it
        // never persists it — same no-persistence-in-index.ts shape as
        // schema_refresh/preview_run. apps/api's profile service is the
        // one that upserts into source_profiles, through its own
        // req.supabase.
        console.log(`[interactive] profile_run for connection ${payload.connectionId} entity ${payload.entity.namespace}.${payload.entity.name}`);
        return await profileEntity(payload);
    }
  },
  { connection, concurrency: 10 },
);

const heavyQueue = new Queue(QUEUE_HEAVY, { connection });

const heavy = new Worker(
  QUEUE_HEAVY,
  async (job: Job) => {
    const payload = HeavyJob.parse(job.data);
    switch (payload.kind) {
      case "etl_run":
        // Block 3 — runEtl.ts owns the full chunked/checkpointed/resumable
        // read-transform-write cycle and self-enqueues the next chunk onto
        // this same heavyQueue instance; this handler only logs and hands
        // off, same no-persistence-in-index.ts shape as every other case.
        console.log(
          `[heavy] etl_run ${payload.runId} node ${payload.nodeId} cursor=${payload.cursor}`,
        );
        return await runEtl(payload, heavyQueue);
      case "eval_run": {
        console.log("[heavy] eval_run: running golden-set suite");
        const report = await runGoldenSuite();
        console.log(
          `[heavy] eval_run: ${report.summary.passed}/${report.summary.total} passed, ` +
            `${report.summary.citationFailures} citation failure(s), ${report.summary.mustRefuseFailures} must-refuse failure(s)`,
        );
        return { status: "ok", summary: report.summary };
      }
      case "staging_sweep": {
        // Phase 11 item 12 — backstop cleanup for staging_objects rows a
        // run's own dropStaging call missed (crash, stuck redelivery, etc).
        // See lib/etl/stagingSweeper.ts's header comment.
        console.log("[heavy] staging_sweep: sweeping stale staging_objects rows");
        const result = await sweepStaleStaging();
        console.log(
          `[heavy] staging_sweep: swept ${result.swept}, skipped ${result.skipped}, failed ${result.failed}`,
        );
        return result;
      }
    }
  },
  // maxStalledCount: 5 — BullMQ's own default is 1, meaning a job is
  // permanently failed ("job stalled more than allowable limit", via
  // job.deferredFailure — bypasses `attempts` entirely, see worker.js's
  // getUnrecoverableErrorMessage) the *second* time it's ever detected
  // stalled, no matter how many `attempts` its opts allow. A worker
  // process that dies mid-chunk (crash, redeploy, `kill -9`) always leaves
  // its current job stalled once; tolerating only one such event across a
  // run's entire lifetime is too fragile for a long-running chunked ETL
  // job that resumes safely from Postgres's checkpoint (see runEtl.ts's
  // header comment) — discovered via Block 4's kill test permanently
  // stalling a run on its second kill.
  { connection, concurrency: 3, maxStalledCount: 5 },
);

// Registered once at boot — upsertJobScheduler is idempotent (keyed by
// schedulerId), so restarting the worker never creates duplicate repeatable
// jobs. See lib/eval/schedule.ts.
await registerNightlyEvalSchedule(heavyQueue);
// Same idempotent-at-boot pattern — see lib/etl/stagingSweepSchedule.ts.
await registerStagingSweepSchedule(heavyQueue);

for (const w of [interactive, heavy]) {
  w.on("failed", (job, err) =>
    console.error(`[${w.name}] job ${job?.id} failed:`, err.message),
  );
}

async function shutdown() {
  console.log("shutting down workers…");
  await Promise.all([interactive.close(), heavy.close()]);
  await heavyQueue.close();
  await shutdownLangfuse();
  await connection.quit();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("Nia worker up: queues [interactive, heavy]");
