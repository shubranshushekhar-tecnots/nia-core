import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import {
  QUEUE_INTERACTIVE,
  QUEUE_HEAVY,
  InteractiveJob,
  EtlRunJob,
} from "@nia/schemas";

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
 *  - heavy: ETL / backfills — chunked, checkpointed, resumable
 */

const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null, // required by BullMQ
});

const interactive = new Worker(
  QUEUE_INTERACTIVE,
  async (job: Job) => {
    const payload = InteractiveJob.parse(job.data);
    switch (payload.kind) {
      case "chat_query":
        // TODO: LangGraph pipeline — rewrite → resolve → generate →
        // guardrails → pooled /execute → cite → faithfulness check
        // TODO: before dispatching the generated query to any connector
        // service, this MUST call @nia/guardrails's validateBeforeDispatch
        // (manifestId, query, connectionScope) and use its sanitizedQuery —
        // no query reaches a connector /execute endpoint unvalidated.
        console.log(`[interactive] chat_query for org ${payload.orgId}`);
        return { status: "stub" };
      case "check_run":
        // TODO: config / credential / grant / mapping / DAG checks
        // TODO: any check that dry-runs a connector query must also route
        // through @nia/guardrails's validateBeforeDispatch first.
        console.log(`[interactive] check_run for workflow ${payload.workflowId}`);
        return { status: "stub" };
    }
  },
  { connection, concurrency: 10 },
);

const heavy = new Worker(
  QUEUE_HEAVY,
  async (job: Job) => {
    const payload = EtlRunJob.parse(job.data);
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
  },
  { connection, concurrency: 3 },
);

for (const w of [interactive, heavy]) {
  w.on("failed", (job, err) =>
    console.error(`[${w.name}] job ${job?.id} failed:`, err.message),
  );
}

async function shutdown() {
  console.log("shutting down workers…");
  await Promise.all([interactive.close(), heavy.close()]);
  await connection.quit();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("Nia worker up: queues [interactive, heavy]");
