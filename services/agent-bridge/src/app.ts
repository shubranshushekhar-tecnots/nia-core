import Fastify from "fastify";
import { z } from "zod";
import { withServiceRole } from "@nia/db";
import { dbPool } from "./db.js";
import { generateAgentKey, sha256Hex } from "./crypto.js";
import { DbAgentTransport, type AgentTransport } from "./transport.js";
import { taskBus } from "./taskBus.js";

/**
 * Thrown by a route handler to force a specific HTTP status. Fastify's
 * default error handler reads `error.statusCode` when present (falls back
 * to 500 otherwise) — see https://fastify.dev/docs/latest/Reference/Errors/.
 */
class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

const CHECK_IN_HOLD_MS = Number(process.env.AGENT_CHECK_IN_HOLD_MS ?? 25_000);

const PairBody = z.object({
  pairingCodeId: z.string().uuid(),
  code: z.string().min(1),
});

// Slice L4 (B.11/B.7) — these two schemas ARE the server-side allow-list:
// zod's default `.strip()` behavior drops any unknown key, so nothing
// outside this exact field set can ever reach storage even if a future
// agent build sent more (e.g. row values, param values, a Planometry
// rejection message). Mirrors apps/agent/src/link/localJobReports.ts's
// `LocalJobReport` and apps/agent/src/link/runReportOutbox.ts's
// `RunReport` exactly.
const LocalJobEntry = z.object({
  id: z.string().min(1),
  name: z.string(),
  connectionName: z.string(),
  sourceTable: z.string(),
  destinationType: z.string(),
  destinationHost: z.string(),
  mode: z.string(),
  schedule: z.string().optional(),
  state: z.enum(["ok", "failing", "paused"]),
  errorClass: z.string().optional(),
  lastRunAt: z.string().optional(),
  nextRunAt: z.string().optional(),
  consecutiveFailures: z.number(),
});

const RunReportEntry = z.object({
  runId: z.string().uuid(),
  jobId: z.string().min(1),
  mode: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
  status: z.enum(["ok", "failed"]),
  rowsSent: z.number(),
  rowsDeleted: z.number(),
  parts: z.number(),
  errorClass: z.string().optional(),
  isRealtimeAggregate: z.boolean().optional(),
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
});

// Slice C1 — same allow-list discipline as LocalJobEntry above: never host/
// user/password, name/db/dialect only (docs/plans/agent-canvas-integration.md
// Slice C1's "agent reports which local connections it has").
const AgentConnectionEntry = z.object({
  id: z.string().min(1),
  name: z.string(),
  database: z.string(),
  dialect: z.string(),
});

const CheckInBody = z
  .object({
    agentVersion: z.string().optional(),
    hostName: z.string().optional(),
    // Set true only on the agent's first check-in after `start` (see
    // apps/agent/src/link/checkInLoop.ts) so the link is confirmed (or
    // refused as revoked) within a second or two instead of waiting out
    // the full hold below. Every later check-in holds as before.
    noHold: z.boolean().optional(),
    // Slice L4 — omitted entirely (not an empty array) means "this agent
    // build doesn't report jobs yet"; must never be treated as "zero
    // jobs" (see the handler below).
    localJobs: z.array(LocalJobEntry).optional(),
    runReports: z.array(RunReportEntry).optional(),
    // Slice C1 — same absent-vs-empty-array discipline as localJobs.
    agentConnections: z.array(AgentConnectionEntry).optional(),
  })
  .optional();

const TaskResultBody = z.object({
  taskId: z.string().uuid(),
  status: z.enum(["done", "failed"]),
  result: z.unknown().optional(),
  errorClass: z.string().optional(),
});

type ConsumeResult = {
  status: "ok" | "not_found" | "locked" | "used" | "expired" | "incorrect";
  org_id: string | null;
  owner_id: string | null;
  created_by_user_id: string | null;
  display_name: string | null;
};

const PAIR_REFUSAL_MESSAGE: Record<Exclude<ConsumeResult["status"], "ok">, string> = {
  not_found: "pairing code not found",
  locked: "pairing code is locked",
  used: "pairing code has already been used",
  expired: "pairing code has expired",
  incorrect: "pairing code is incorrect",
};

type AgentRow = {
  id: string;
  status: "pending" | "active" | "revoked";
};

/**
 * Factory (not a module-level singleton) so tests can inject a fake
 * AgentTransport and skip the real 25-second check-in hold — see
 * src/transport.ts's header comment.
 */
export function buildApp(transport: AgentTransport = new DbAgentTransport(dbPool)) {
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({ status: "ok" as const, service: "agent-bridge" }));

  // docs/plans/agent-canvas-integration.md B.12: {pairingCodeId, code} — the
  // id is a non-secret lookup key (lets consume_agent_pairing_code count
  // wrong attempts per-row without the lookup itself being a guessable
  // oracle), the code is the one-time secret, hashed here before ever
  // reaching Postgres (consume_agent_pairing_code only ever sees the hash).
  //
  // Routes live under /agent-api so the path is identical in dev (the CLI
  // calls this service directly, e.g. http://localhost:4040/agent-api/pair
  // — see apps/agent/src/link/pairing.ts) and in production (deploy/nginx/
  // nginx.conf's /agent-api/ location passes the path through unchanged,
  // no rewrite).
  app.post("/agent-api/pair", async (req) => {
    const { pairingCodeId, code } = PairBody.parse(req.body);
    const codeHash = sha256Hex(code);

    // consume_agent_pairing_code returns a status instead of raising for any
    // ordinary refusal (0069_platform_agents.sql's header comment on this
    // RPC) — raising would roll back the very attempt_count/locked_at
    // update it needs to persist, since withServiceRole runs one call as
    // one BEGIN/COMMIT.
    const { rows } = await withServiceRole(dbPool, (db) =>
      db.query<ConsumeResult>("select * from public.consume_agent_pairing_code($1, $2)", [pairingCodeId, codeHash]),
    );
    const result = rows[0];
    if (!result) throw new HttpError(401, "pairing code is invalid");
    if (result.status !== "ok") throw new HttpError(401, PAIR_REFUSAL_MESSAGE[result.status]);

    const agentKey = generateAgentKey();
    const agentKeyHash = sha256Hex(agentKey);

    const { rows: agentRows } = await withServiceRole(dbPool, (db) =>
      db.query<{ id: string }>(
        `insert into public.platform_agents
           (org_id, owner_id, created_by_user_id, display_name, agent_key_hash, status)
         values ($1, $2, $3, $4, $5, 'active')
         returning id`,
        [
          result.org_id,
          result.owner_id,
          result.created_by_user_id,
          result.display_name ?? `Agent paired ${new Date().toISOString()}`,
          agentKeyHash,
        ],
      ),
    );
    const agentId = agentRows[0]?.id;
    if (!agentId) throw new HttpError(500, "failed to create agent record");

    return { agentId, agentKey };
  });

  // Authenticated by the agent key itself (Bearer), not a user session —
  // see 0069_platform_agents.sql's header comment ("no acting user").
  app.post("/agent-api/check-in", async (req) => {
    const authHeader = req.headers.authorization ?? "";
    const agentKey = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
    if (!agentKey) throw new HttpError(401, "missing agent key");

    const { agentVersion, hostName, noHold, localJobs, runReports, agentConnections } =
      CheckInBody.parse(req.body) ?? {};
    const agentKeyHash = sha256Hex(agentKey);

    const { rows, acknowledgedRunIds } = await withServiceRole(dbPool, async (db) => {
      const { rows } = await db.query<AgentRow>(
        `update public.platform_agents
           set last_check_in_at = now(),
               agent_version = coalesce($2, agent_version),
               host_name = coalesce($3, host_name)
         where agent_key_hash = $1 and status <> 'revoked'
         returning id, status`,
        [agentKeyHash, agentVersion ?? null, hostName ?? null],
      );
      const agent = rows[0];
      if (!agent) return { rows, acknowledgedRunIds: [] as string[] };

      // Slice L4 (B.11, Change 4) — an *absent* localJobs key means this
      // agent build doesn't report jobs; never treat that as "zero jobs".
      // Only an actually-present (possibly empty) array drives upsert +
      // soft-remove.
      if (localJobs !== undefined) {
        for (const job of localJobs) {
          await db.query(
            `insert into public.agent_setups (agent_id, local_job_id, source, local_job_report, removed_at, updated_at)
             values ($1, $2, 'local', $3::jsonb, null, now())
             on conflict (agent_id, local_job_id) do update
               set local_job_report = excluded.local_job_report, removed_at = null, updated_at = now()`,
            [agent.id, job.id, JSON.stringify(job)],
          );
        }
        const reportedIds = localJobs.map((j) => j.id);
        await db.query(
          `update public.agent_setups
             set removed_at = now()
           where agent_id = $1 and source = 'local' and removed_at is null
             and local_job_id <> all($2::text[])`,
          [agent.id, reportedIds],
        );
      }

      // Slice C1 — same absent-vs-empty-array discipline as localJobs above.
      if (agentConnections !== undefined) {
        for (const conn of agentConnections) {
          await db.query(
            `insert into public.agent_reported_connections
               (agent_id, local_connection_id, name, database_name, dialect, removed_at, updated_at)
             values ($1, $2, $3, $4, $5, null, now())
             on conflict (agent_id, local_connection_id) do update
               set name = excluded.name, database_name = excluded.database_name,
                   dialect = excluded.dialect, removed_at = null, updated_at = now()`,
            [agent.id, conn.id, conn.name, conn.database, conn.dialect],
          );
        }
        const reportedConnectionIds = agentConnections.map((c) => c.id);
        await db.query(
          `update public.agent_reported_connections
             set removed_at = now()
           where agent_id = $1 and removed_at is null
             and local_connection_id <> all($2::text[])`,
          [agent.id, reportedConnectionIds],
        );
      }

      const acknowledgedRunIds: string[] = [];
      for (const report of runReports ?? []) {
        const { rows: inserted } = await db.query<{ run_id: string }>(
          `with target as (
             select id from public.agent_setups
             where agent_id = $1 and source = 'local' and local_job_id = $2
           )
           insert into public.agent_setup_runs
             (agent_setup_id, run_id, status, rows_sent, rows_deleted, parts, mode, error_class, started_at, finished_at, is_realtime_aggregate, period_start, period_end)
           select target.id, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
           from target
           on conflict (run_id) do nothing
           returning run_id`,
          [
            agent.id,
            report.jobId,
            report.runId,
            report.status,
            report.rowsSent,
            report.rowsDeleted,
            report.parts,
            report.mode ?? null,
            report.errorClass ?? null,
            report.startedAt,
            report.finishedAt,
            report.isRealtimeAggregate ?? false,
            report.periodStart ?? null,
            report.periodEnd ?? null,
          ],
        );
        // Acknowledge regardless of whether this insert was new or a no-op
        // (on-conflict) — a resend of an already-stored run_id must still
        // be dropped from the agent's outbox. Only a report whose
        // agent_setup wasn't found (target empty) is left unacknowledged,
        // so the agent retries it once the matching localJobs upsert lands.
        if (inserted.length > 0) {
          acknowledgedRunIds.push(report.runId);
        } else {
          const { rows: exists } = await db.query<{ run_id: string }>(
            `select run_id from public.agent_setup_runs where run_id = $1`,
            [report.runId],
          );
          if (exists.length > 0) acknowledgedRunIds.push(report.runId);
        }
      }

      return { rows, acknowledgedRunIds };
    });
    const agent = rows[0];
    if (!agent) throw new HttpError(401, "agent key is invalid or revoked");

    const delivered = await transport.waitForTasks(agent.id, noHold ? 0 : CHECK_IN_HOLD_MS);
    // Flatten to exactly what the agent's taskRunner needs — the platform's
    // own connections.id (connectionId) is never exposed to the agent, only
    // the agent's own local_connection_id that connection resolves to.
    const tasks = delivered.map((task) => ({
      id: task.id,
      kind: task.kind,
      localConnectionId: task.payload.localConnectionId,
    }));
    return { tasks, acknowledgedRunIds };
  });

  // Slice C1 (point 1) — the ONLY path a task result ever travels; never
  // carried on the next check-in. Authenticated the same way as check-in
  // (Bearer agent key, no acting user).
  app.post("/agent-api/task-results", async (req) => {
    const authHeader = req.headers.authorization ?? "";
    const agentKey = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
    if (!agentKey) throw new HttpError(401, "missing agent key");

    const { taskId, status, result, errorClass } = TaskResultBody.parse(req.body);
    const agentKeyHash = sha256Hex(agentKey);

    const { rows } = await withServiceRole(dbPool, (db) =>
      db.query<{ id: string }>(
        `update public.agent_tasks t
           set status = $3, result = $4::jsonb, error_class = $5, completed_at = now()
         where t.id = $2
           and t.agent_id = (select id from public.platform_agents where agent_key_hash = $1 and status <> 'revoked')
           and t.status = 'delivered'
         returning t.id`,
        [agentKeyHash, taskId, status, result !== undefined ? JSON.stringify(result) : null, errorClass ?? null],
      ),
    );
    const updated = rows[0];
    if (!updated) throw new HttpError(404, "task not found, not yours, or already resolved");

    taskBus.resolveTaskResult(taskId, { status, result, errorClass });
    return { ok: true as const };
  });

  return app;
}
