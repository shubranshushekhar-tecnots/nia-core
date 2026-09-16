import { Worker, Queue, type Job } from "bullmq";
import { Redis } from "ioredis";
import {
  QUEUE_INTERACTIVE,
  QUEUE_HEAVY,
  InteractiveJob,
  HeavyJob,
} from "@nia/schemas";
import { runChatQuery } from "./lib/chat/runChatQuery.js";
import { runGoldenSuite } from "./lib/eval/runGoldenSuite.js";
import { registerNightlyEvalSchedule } from "./lib/eval/schedule.js";
import { shutdownLangfuse } from "./lib/observability/langfuse.js";

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
        // NOT wired to lib/dispatch.ts: CheckRunJob (@nia/schemas jobs.ts)
        // carries no connectionIds at all, and there is no workflowId ->
        // connectionId mapping anywhere in the codebase — workflow
        // definitions store canvas nodes as opaque, untyped jsonb (see the
        // comment on deleteConnection in
        // apps/api/src/services/connections.ts). The "credentials" check in
        // particular needs a real connectionId to dispatch a probe against,
        // and there's no way to derive one from a workflowId today. This is
        // a genuine schema gap (a canvas node schema has to exist first),
        // flagged rather than worked around with a fabricated connectionId.
        console.log(`[interactive] check_run for workflow ${payload.workflowId}`);
        return { status: "stub" };
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
        // TODO: read chunk from source via connector service, apply in-stream
        // transforms not compiled into the dialect, upsert into sink (idempotent),
        // persist checkpoint cursor to Postgres, enqueue next chunk.
        // TODO: the source-side read query must go through @nia/guardrails's
        // validateBeforeDispatch (manifestId, query, connectionScope) before
        // it's sent to the source connector service's /execute endpoint.
        console.log(
          `[heavy] etl_run ${payload.runId} node ${payload.nodeId} cursor=${payload.cursor}`,
        );
        return { status: "stub" };
      case "eval_run": {
        console.log("[heavy] eval_run: running golden-set suite");
        const report = await runGoldenSuite();
        console.log(
          `[heavy] eval_run: ${report.summary.passed}/${report.summary.total} passed, ` +
            `${report.summary.citationFailures} citation failure(s), ${report.summary.mustRefuseFailures} must-refuse failure(s)`,
        );
        return { status: "ok", summary: report.summary };
      }
    }
  },
  { connection, concurrency: 3 },
);

// Registered once at boot — upsertJobScheduler is idempotent (keyed by
// schedulerId), so restarting the worker never creates duplicate repeatable
// jobs. See lib/eval/schedule.ts.
await registerNightlyEvalSchedule(heavyQueue);

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
