import Fastify from "fastify";
import { z } from "zod";
import { gunzipSync } from "node:zlib";
import { withServiceRole } from "@nia/db";
import { decryptSecret, parseMasterKey, type EncryptedSecret } from "@nia/secrets";
import {
  Column,
  StructuredQueryCursor,
  isAgentVersionTooOld,
  MIN_AGENT_VERSION,
  GraphDoc,
  getConnectorManifest,
  type GraphDoc as GraphDocType,
  type GraphNode as GraphNodeType,
} from "@nia/schemas";
import { dbPool } from "./db.js";
import { generateAgentKey, sha256Hex } from "./crypto.js";
import { DbAgentTransport, type AgentTransport } from "./transport.js";
import { taskBus } from "./taskBus.js";
import { batchKeyFor, putCachedBatch } from "./readAheadCache.js";

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

// Slice T2, plan point 3 — "at most 20 MB per batch", on the compressed
// upload itself (what actually crosses the wire), not the decompressed
// size. Checked explicitly against Content-Length below, with the
// route's own Fastify bodyLimit set a bit above this as a hard backstop
// (so a request with no/a lying Content-Length header still can't slip
// past as an unbounded read into memory).
const READ_BATCH_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const READ_BATCH_UPLOAD_TOO_LARGE_MESSAGE = "batch exceeds the 20 MB upload cap — select fewer columns and try again";

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
  // Slice R5a (apps/agent's SetupManager — LocalJobReport.setupId) — set
  // only for a platform-managed job (platformManaged.setupId), absent for
  // a genuine CLI-local job. Present/absent, not a separate "source" enum,
  // mirrors the rest of this check-in body's own absent-vs-empty discipline.
  setupId: z.string().uuid().optional(),
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
  // Slice R5a — same platformManaged tag as LocalJobEntry.setupId above
  // (RecordRunInput.setupId / RunReport.setupId on apps/agent's side).
  setupId: z.string().uuid().optional(),
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

// Slice T2, plan point 2/3 — one decompressed batch upload body, shaped
// exactly like readAheadCache.ts's CachedBatch (cursor added: the
// starting cursor this specific batch answers, used to compute the
// cache key — "keyed by its starting cursor").
const UploadedBatchBody = z.object({
  cursor: StructuredQueryCursor.nullable(),
  columns: z.array(Column),
  rows: z.array(z.array(z.unknown())),
  nextCursor: StructuredQueryCursor.nullable(),
  isLast: z.boolean(),
});

// Slice R3a (B.4) — exactly one of the two: applying a version clears any
// previous rejection, rejecting leaves applied_version untouched. Never
// both in the same report.
const SetupReportBody = z
  .object({
    appliedVersion: z.number().int().nonnegative().optional(),
    rejectionReason: z.string().min(1).optional(),
  })
  .refine((body) => (body.appliedVersion !== undefined) !== (body.rejectionReason !== undefined), {
    message: "exactly one of appliedVersion or rejectionReason is required",
  });

// Workflows screen (agent app) — deliberately narrower than apps/api's
// AgentSetupActionRequest: `allowMassDelete` is NOT accepted from the
// agent app at all. The mass-delete guard exists so a human reviews the
// situation on the website (which shows the rows that would be deleted)
// before overriding it — the agent app has no such review UI, so it must
// never be able to request the override. `.strict()` makes any request
// that includes an `allowMassDelete` key (true or false) fail parsing
// outright, rather than silently stripping it.
const WorkflowActionBody = z
  .object({
    kind: z.enum(["run_now", "pause", "resume"]),
    params: z.record(z.string(), z.string()).optional(),
    fullReload: z.boolean().optional(),
  })
  .strict();

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
  org_id: string | null;
  owner_id: string | null;
};

type NiaSecretRow = {
  ciphertext: string;
  encrypted_data_key: string;
  iv: string;
  auth_tag: string;
  algorithm: string;
  key_version: number;
};

/**
 * Shared by the three Slice R3a setup routes below (check-in and
 * task-results, above, predate this slice and keep their own inline
 * Bearer-parsing — left as-is to minimize the diff on existing code).
 */
function extractAgentKey(authHeader: string | undefined): string {
  const agentKey = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
  if (!agentKey) throw new HttpError(401, "missing agent key");
  return agentKey;
}

async function resolveAgentFromKey(
  agentKey: string,
): Promise<{ id: string; createdByUserId: string; orgId: string | null; ownerId: string | null; hostName: string | null } | null> {
  const agentKeyHash = sha256Hex(agentKey);
  const { rows } = await withServiceRole(dbPool, (db) =>
    db.query<{ id: string; created_by_user_id: string; org_id: string | null; owner_id: string | null; host_name: string | null }>(
      `select id, created_by_user_id, org_id, owner_id, host_name from public.platform_agents where agent_key_hash = $1 and status <> 'revoked'`,
      [agentKeyHash],
    ),
  );
  const row = rows[0];
  return row
    ? { id: row.id, createdByUserId: row.created_by_user_id, orgId: row.org_id, ownerId: row.owner_id, hostName: row.host_name }
    : null;
}

type WorkflowStatus = "ok" | "failing" | "paused" | "rejected" | "waiting";

/**
 * Mirrors apps/api/src/services/agentSetups.ts's toState() precedence
 * exactly (wanted_version <= applied_version wins first, folding in the
 * live job state; otherwise a stored rejection beats plain "waiting") —
 * same status a user would see on the website for this setup, just
 * flattened to one enum since the agent app has no separate "applied"
 * concept to show.
 */
function deriveWorkflowStatus(row: {
  wanted_version: number;
  applied_version: number;
  rejection_reason: string | null;
  platform_job_state: Record<string, unknown> | null;
}): { status: WorkflowStatus; errorClass: string | null; rejectionReason: string | null; nextRunAt: string | null } {
  if (row.wanted_version <= row.applied_version) {
    const jobState = row.platform_job_state;
    const rawState = jobState?.["state"];
    const status: WorkflowStatus = rawState === "failing" ? "failing" : rawState === "paused" ? "paused" : "ok";
    return {
      status,
      errorClass: typeof jobState?.["errorClass"] === "string" ? (jobState["errorClass"] as string) : null,
      rejectionReason: null,
      nextRunAt: typeof jobState?.["nextRunAt"] === "string" ? (jobState["nextRunAt"] as string) : null,
    };
  }
  if (row.rejection_reason) {
    return { status: "rejected", errorClass: null, rejectionReason: row.rejection_reason, nextRunAt: null };
  }
  return { status: "waiting", errorClass: null, rejectionReason: null, nextRunAt: null };
}

/** Same host-region regex as apps/web/src/lib/connections/types.ts's connectionRegion — reimplemented standalone here (tiny, pragmatic duplication) rather than pulling apps/web's connections module into agent-bridge. */
const CONNECTION_REGION_PATTERN = /\b([a-z]{2}-[a-z]+-\d)\b/;

type SanitizedGraphNode = {
  id: string;
  type: "source" | "transform" | "destination";
  position: { x: number; y: number };
  manifestName: string | null;
  connectionLabel: string | null;
  region: string | null;
  entityLabel: string | null;
  writeModeLabel: string | null;
  resolved: boolean;
  unknownReason: string | null;
};

/**
 * Allowlist mapper for GET /agent-api/workflows/:workflowId/graph — the
 * ONLY place the sanitized response is built. Every field is read
 * individually off `node`/`connection`; `node.config` and the
 * connection's raw `config`/`vault_secret_ref` are never spread or
 * passed through, so it's structurally impossible for a future config
 * field to leak here by accident. Mirrors apps/web/src/lib/canvas/
 * mapping.ts's resolveCanvasNode + GraphFlowNode.tsx's readEntityLabel/
 * readWriteMode wording exactly, so the agent app's canvas reads the same
 * as the website's for the parts that have no live check-run data.
 */
function mapGraphNodeForAgent(
  node: GraphNodeType,
  connectionsById: Map<string, { id: string; display_name: string; config: Record<string, unknown> }>,
): SanitizedGraphNode {
  const manifest = node.manifestId ? getConnectorManifest(node.manifestId) : undefined;
  const connection = node.connectionId ? connectionsById.get(node.connectionId) : undefined;

  let resolved = true;
  let unknownReason: string | null = null;
  if (node.manifestId && !manifest) {
    resolved = false;
    unknownReason = `Unknown tool "${node.manifestId}"`;
  } else if (node.connectionId && !connection) {
    resolved = false;
    unknownReason = "Connection not found";
  }

  const host = typeof connection?.config["host"] === "string" ? (connection.config["host"] as string) : undefined;
  const database = typeof connection?.config["database"] === "string" ? (connection.config["database"] as string) : undefined;
  const secondary = host && database ? `${host}/${database}` : host ?? database;
  const connectionLabel = connection ? (secondary ? `${connection.display_name} (${secondary})` : connection.display_name) : null;
  const region = host ? host.match(CONNECTION_REGION_PATTERN)?.[1] ?? null : null;

  const entity = node.config["entity"];
  const entityName =
    entity && typeof entity === "object" && "name" in entity && typeof (entity as { name: unknown }).name === "string"
      ? ((entity as { name: string }).name as string)
      : undefined;
  const entityNamespace =
    entity && typeof entity === "object" && "namespace" in entity && typeof (entity as { namespace: unknown }).namespace === "string"
      ? ((entity as { namespace: string }).namespace as string)
      : undefined;
  const entityLabel = entityName ? (entityNamespace ? `${entityNamespace}.${entityName}` : entityName) : null;

  const writeMode = node.config["writeMode"];
  const writeModeLabel = writeMode === "direct" ? "Direct write" : writeMode === "staged" ? "Staged write" : null;

  return {
    id: node.id,
    type: node.type,
    position: node.position,
    manifestName: manifest?.name ?? null,
    connectionLabel,
    region,
    entityLabel,
    writeModeLabel: node.type === "destination" ? writeModeLabel : null,
    resolved,
    unknownReason,
  };
}

/**
 * Factory (not a module-level singleton) so tests can inject a fake
 * AgentTransport and skip the real 25-second check-in hold — see
 * src/transport.ts's header comment.
 */
export function buildApp(transport: AgentTransport = new DbAgentTransport(dbPool)) {
  const app = Fastify({ logger: true });

  // Slice T2, plan point 3 — the read-batch upload body is raw gzip
  // bytes, not JSON; Fastify's built-in parsers only cover
  // application/json and text/plain, so this content type needs its own
  // parser, registered once here rather than per-route. Hands the buffer
  // through completely unparsed — decompression/validation happens in
  // the route handler itself, after the task-ownership check.
  app.addContentTypeParser("application/gzip", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

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

    // Safeguards slice: agent.paired audit entry — who (created_by_user_id,
    // the pairing member), when (created_at default), which org/workspace
    // (org_id xor owner_id), which agent (agentId). No RPC exists for this
    // (unlike revoke_agent's own private.log_audit call, 0069) and there's
    // no connection_id to key a log_connection_audit call off, so this
    // writes audit_log directly — service_role already holds a plain
    // GRANT ALL on audit_log (confirmed against 0001/0007's grants).
    // Detail never carries the agent key or any secret.
    await withServiceRole(dbPool, (db) =>
      db.query(
        `insert into public.audit_log (org_id, owner_id, actor, action, detail)
         values ($1, $2, $3, 'agent.paired', $4::jsonb)`,
        [result.org_id, result.owner_id, result.created_by_user_id, JSON.stringify({ agentId })],
      ),
    );

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

    // Slice E — refuse the check-in outright for an agent build older than
    // MIN_AGENT_VERSION, but still record the reported version so the
    // Agents page can show "update required" without a DB migration
    // (agent_version already existed on platform_agents).
    if (agentVersion !== undefined && isAgentVersionTooOld(agentVersion, MIN_AGENT_VERSION)) {
      await withServiceRole(dbPool, (db) =>
        db.query(
          `update public.platform_agents set agent_version = $2 where agent_key_hash = $1 and status <> 'revoked'`,
          [agentKeyHash, agentVersion],
        ),
      );
      throw new HttpError(
        426,
        `agent version ${agentVersion} is older than the minimum supported version ${MIN_AGENT_VERSION} — update the agent to continue checking in.`,
      );
    }

    const { rows, acknowledgedRunIds } = await withServiceRole(dbPool, async (db) => {
      const { rows } = await db.query<AgentRow>(
        `update public.platform_agents
           set last_check_in_at = now(),
               agent_version = coalesce($2, agent_version),
               host_name = coalesce($3, host_name)
         where agent_key_hash = $1 and status <> 'revoked'
         returning id, status, org_id, owner_id`,
        [agentKeyHash, agentVersion ?? null, hostName ?? null],
      );
      const agent = rows[0];
      if (!agent) return { rows, acknowledgedRunIds: [] as string[] };

      // Slice L4 (B.11, Change 4) — an *absent* localJobs key means this
      // agent build doesn't report jobs; never treat that as "zero jobs".
      // Only an actually-present (possibly empty) array drives upsert +
      // soft-remove.
      //
      // Slice R5a — a platform-managed job (entry.setupId set) is reported
      // through this same array, but it is never stored as a source='local'
      // row: it already has a source='platform' agent_setups row (created
      // by publish_agent_setup), and that row's own id is what apps/agent's
      // SetupManager uses as the job's local id, so entry.id === entry.setupId
      // for these. Only its platform_job_state is updated; the true-local
      // upsert/soft-remove below is scoped to the remaining entries so it
      // never touches these ids.
      if (localJobs !== undefined) {
        const trueLocalJobs = localJobs.filter((job) => job.setupId === undefined);
        const platformJobs = localJobs.filter((job) => job.setupId !== undefined);

        for (const job of trueLocalJobs) {
          await db.query(
            `insert into public.agent_setups (agent_id, local_job_id, source, local_job_report, removed_at, updated_at)
             values ($1, $2, 'local', $3::jsonb, null, now())
             on conflict (agent_id, local_job_id) do update
               set local_job_report = excluded.local_job_report, removed_at = null, updated_at = now()`,
            [agent.id, job.id, JSON.stringify(job)],
          );
        }
        const reportedIds = trueLocalJobs.map((j) => j.id);
        await db.query(
          `update public.agent_setups
             set removed_at = now()
           where agent_id = $1 and source = 'local' and removed_at is null
             and local_job_id <> all($2::text[])`,
          [agent.id, reportedIds],
        );

        for (const job of platformJobs) {
          await db.query(
            `update public.agent_setups
               set platform_job_state = $3::jsonb, updated_at = now()
             where agent_id = $1 and source = 'platform' and id = $2`,
            [agent.id, job.setupId, JSON.stringify(job)],
          );
        }
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
        // Slice R5a — a run report carrying setupId attaches directly to
        // that source='platform' row; a plain CLI-local report (no
        // setupId) still resolves via local_job_id as before. Exactly one
        // of the two `target` branches ever matches for a given report.
        const { rows: inserted } = await db.query<{ run_id: string }>(
          `with target as (
             select id from public.agent_setups
             where agent_id = $1
               and (
                 (source = 'platform' and id = $15)
                 or (source = 'local' and local_job_id = $2)
               )
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
            report.setupId ?? null,
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

        // Safeguards slice: rows an agent's run reports count toward the
        // org's/workspace's monthly row usage, same measure+table a normal
        // workflow run uses (usage_events, kind='rows_moved',
        // subject_id=runId) — 0066_usage_events.sql's own unique index on
        // (kind, subject_id) is exactly the "once per run id, a report
        // received twice counts once" idempotency this needs, so the same
        // report redelivered (acknowledgedRunIds already handles the
        // agent_setup_runs side of that) just no-ops here too via
        // `on conflict do nothing` — no separate dedup logic required.
        if (report.rowsSent > 0) {
          await db.query(
            `insert into public.usage_events (org_id, owner_id, kind, quantity, subject_id)
             values ($1, $2, 'rows_moved', $3, $4)
             on conflict (kind, subject_id) do nothing`,
            [agent.org_id, agent.owner_id, report.rowsSent, report.runId],
          );
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
    //
    // Slice R5a — run_now/pause/resume/test_job act on an agent_setups row
    // instead of a connection. agentSetupId is exposed as-is (not
    // translated, unlike localConnectionId above) because a platform-
    // managed job's local id already IS the setup's own platform id (see
    // the localJobs handling above) — no separate local/platform id
    // mapping exists for setups the way it does for connections. payload
    // carries the action's own one-off fields (run_now's params/
    // fullReload/allowMassDelete); always {} for pause/resume/test_job.
    const tasks = delivered.map((task) => {
      if (task.kind === "test_connection" || task.kind === "list_tables") {
        return { id: task.id, kind: task.kind, localConnectionId: task.payload.localConnectionId };
      }
      // Slice T2 — read_batch's payload already carries localConnectionId
      // merged in (transport.ts's claimPending), alongside the structured
      // read fields (table/columns/filter/cursor/limit/batchCount/
      // signatureKey) — passed through whole. Unlike run_now/pause/resume/
      // test_job below, read_batch has no agentSetupId (it targets a
      // connection, not a platform-managed job).
      if (task.kind === "read_batch") {
        return { id: task.id, kind: task.kind, payload: task.payload };
      }
      return { id: task.id, kind: task.kind, agentSetupId: task.agentSetupId, payload: task.payload };
    });

    // Slice R3a (B.4) — queried fresh AFTER the hold (not before), so a
    // publish/unpublish that arrives mid-hold and wakes this check-in via
    // taskBus (notifyListener.ts) is reflected in this same response, not
    // just the next one. wanted-vs-applied, not a one-off task, so nothing
    // is lost while the agent is offline — a plain poll on every check-in.
    const { rows: setupRows } = await withServiceRole(dbPool, (db) =>
      db.query<{
        id: string;
        workflow_id: string;
        wanted_version: number;
        applied_version: number;
        unpublished_at: string | null;
      }>(
        `select id, workflow_id, wanted_version, applied_version, unpublished_at
         from public.agent_setups
         where agent_id = $1 and source = 'platform'`,
        [agent.id],
      ),
    );
    const setups = setupRows.map((row) => ({
      id: row.id,
      workflowId: row.workflow_id,
      wantedVersion: row.wanted_version,
      appliedVersion: row.applied_version,
      removed: row.unpublished_at !== null,
    }));

    return { tasks, acknowledgedRunIds, setups };
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
      db.query<{ id: string; kind: string; payload: Record<string, unknown> }>(
        `update public.agent_tasks t
           set status = $3, result = $4::jsonb, error_class = $5, completed_at = now()
         where t.id = $2
           and t.agent_id = (select id from public.platform_agents where agent_key_hash = $1 and status <> 'revoked')
           and t.status = 'delivered'
         returning t.id, t.kind, t.payload`,
        [agentKeyHash, taskId, status, result !== undefined ? JSON.stringify(result) : null, errorClass ?? null],
      ),
    );
    const updated = rows[0];
    if (!updated) throw new HttpError(404, "task not found, not yours, or already resolved");

    taskBus.resolveTaskResult(taskId, { status, result, errorClass });

    // Slice T2, plan point 5 — a read_batch task that fails (or that the
    // agent reports done without ever reaching the dedicated upload
    // route below, e.g. stopped mid-read) must not leave a pending
    // /execute hanging out its own timeout. The task's own stored
    // payload carries the signatureKey and starting cursor it was asked
    // for, which is exactly the cache key a waiting /execute is parked
    // on for the FIRST batch of this task; later read-ahead batches have
    // no waiter (plan point 2 — only the first is awaited synchronously)
    // so this is a no-op for those, which is fine.
    if (status === "failed" && updated.kind === "read_batch") {
      const signatureKey = typeof updated.payload.signatureKey === "string" ? updated.payload.signatureKey : null;
      if (signatureKey) {
        const cursor = (updated.payload.cursor ?? null) as z.infer<typeof StructuredQueryCursor> | null;
        taskBus.rejectBatch(batchKeyFor(signatureKey, cursor), errorClass);
      }
    }

    return { ok: true as const };
  });

  // Slice T2, plan point 3 — the dedicated authenticated call for the
  // agent to upload one batch of a read_batch task: compressed JSON
  // (gzip), at most 20 MB per batch. Only the agent that owns the task
  // may upload to it (ownership checked the same way task-results checks
  // it — by agent_id, via the same key). The content-type parser below
  // (registered once, outside this handler) hands the raw gzip bytes
  // through unparsed; everything else is handled here.
  app.post<{ Params: { taskId: string } }>(
    "/agent-api/read-batches/:taskId",
    { bodyLimit: READ_BATCH_UPLOAD_MAX_BYTES + 1024 * 1024 },
    async (req) => {
      const agentKey = extractAgentKey(req.headers.authorization);
      const agent = await resolveAgentFromKey(agentKey);
      if (!agent) throw new HttpError(401, "agent key is invalid or revoked");

      const contentLength = Number(req.headers["content-length"] ?? 0);
      if (contentLength > READ_BATCH_UPLOAD_MAX_BYTES) {
        throw new HttpError(413, READ_BATCH_UPLOAD_TOO_LARGE_MESSAGE);
      }

      const { rows } = await withServiceRole(dbPool, (db) =>
        db.query<{ payload: Record<string, unknown> }>(
          `select payload from public.agent_tasks
           where id = $1 and kind = 'read_batch' and status = 'delivered'
             and agent_id = (select id from public.platform_agents where agent_key_hash = $2 and status <> 'revoked')`,
          [req.params.taskId, sha256Hex(agentKey)],
        ),
      );
      const task = rows[0];
      if (!task) throw new HttpError(404, "task not found, not yours, or already resolved");

      const compressed = req.body as Buffer;
      if (compressed.length > READ_BATCH_UPLOAD_MAX_BYTES) {
        throw new HttpError(413, READ_BATCH_UPLOAD_TOO_LARGE_MESSAGE);
      }

      let decompressed: Buffer;
      try {
        decompressed = gunzipSync(compressed);
      } catch {
        throw new HttpError(400, "batch payload is not valid gzip");
      }

      let parsed: z.infer<typeof UploadedBatchBody>;
      try {
        parsed = UploadedBatchBody.parse(JSON.parse(decompressed.toString("utf8")));
      } catch {
        throw new HttpError(400, "batch payload is not a valid batch");
      }

      const signatureKey = typeof task.payload.signatureKey === "string" ? task.payload.signatureKey : null;
      if (!signatureKey) throw new HttpError(500, "task is missing its signature key");

      const cacheKey = batchKeyFor(signatureKey, parsed.cursor);
      const cached = { columns: parsed.columns, rows: parsed.rows, nextCursor: parsed.nextCursor, isLast: parsed.isLast };
      await putCachedBatch(cacheKey, cached);
      taskBus.resolveBatch(cacheKey, cached);

      return { ok: true as const };
    },
  );

  // Slice R3a (B.4) — fetch one platform setup by id. No secrets: the
  // destination connection's own `config` is non-secret by construction
  // (0007_connectors.sql splits secret manifest fields into
  // vault_secret_ref, never into config), and published_setup
  // (AgentJobSetup) carries none by schema. Only the owning agent may
  // fetch — another agent's key gets the same 404 as "doesn't exist".
  app.get<{ Params: { id: string } }>("/agent-api/setups/:id", async (req) => {
    const agentKey = extractAgentKey(req.headers.authorization);
    const agent = await resolveAgentFromKey(agentKey);
    if (!agent) throw new HttpError(401, "agent key is invalid or revoked");

    const { rows } = await withServiceRole(dbPool, (db) =>
      db.query<{
        id: string;
        agent_id: string;
        workflow_id: string;
        wanted_version: number;
        published_setup: Record<string, unknown> | null;
        unpublished_at: string | null;
        connection_id: string | null;
        destination_connection_id: string | null;
      }>(
        `select id, agent_id, workflow_id, wanted_version, published_setup, unpublished_at, connection_id, destination_connection_id
         from public.agent_setups
         where id = $1 and source = 'platform'`,
        [req.params.id],
      ),
    );
    const setup = rows[0];
    if (!setup || setup.agent_id !== agent.id || setup.unpublished_at !== null) {
      throw new HttpError(404, "setup not found");
    }

    const { rows: connRows } = await withServiceRole(dbPool, (db) =>
      db.query<{ id: string; connector_id: string; config: Record<string, unknown> }>(
        `select id, connector_id, config from public.connections where id = any($1::uuid[])`,
        [[setup.connection_id, setup.destination_connection_id]],
      ),
    );
    const source = connRows.find((row) => row.id === setup.connection_id);
    const destination = connRows.find((row) => row.id === setup.destination_connection_id);
    if (!destination) throw new HttpError(404, "destination connection not found");

    // The platform's own connections.id for the source is meaningless to
    // the agent locally — same resolution transport.ts already does for
    // task connectionId/localConnectionId.
    const localSourceConnectionId =
      typeof source?.config?.["agentConnectionId"] === "string" ? (source.config["agentConnectionId"] as string) : null;

    return {
      id: setup.id,
      workflowId: setup.workflow_id,
      wantedVersion: setup.wanted_version,
      setup: setup.published_setup,
      localSourceConnectionId,
      destination: { connectorId: destination.connector_id, config: destination.config },
    };
  });

  // Slice R3a (B.4) — the destination's decrypted secret, separately from
  // the no-secrets setup fetch above. Only the owning agent gets it; the
  // value is never logged (returned directly, never passed to app.log);
  // the fetch is recorded via log_connection_audit without the value.
  app.get<{ Params: { id: string } }>("/agent-api/setups/:id/secret", async (req) => {
    const agentKey = extractAgentKey(req.headers.authorization);
    const agent = await resolveAgentFromKey(agentKey);
    if (!agent) throw new HttpError(401, "agent key is invalid or revoked");

    const { rows } = await withServiceRole(dbPool, (db) =>
      db.query<{ agent_id: string; unpublished_at: string | null; destination_connection_id: string | null }>(
        `select agent_id, unpublished_at, destination_connection_id from public.agent_setups where id = $1 and source = 'platform'`,
        [req.params.id],
      ),
    );
    const setup = rows[0];
    // Same message whether the row doesn't exist, belongs to another
    // agent, or has been unpublished — never lets a caller distinguish
    // "wrong agent" from "no such setup".
    if (!setup || setup.agent_id !== agent.id || setup.unpublished_at !== null || !setup.destination_connection_id) {
      throw new HttpError(404, "setup not found");
    }

    const { rows: connRows } = await withServiceRole(dbPool, (db) =>
      db.query<{ vault_secret_ref: string }>(`select vault_secret_ref from public.connections where id = $1`, [
        setup.destination_connection_id,
      ]),
    );
    const ref = connRows[0]?.vault_secret_ref;
    if (!ref) throw new HttpError(404, "destination connection not found");

    const { rows: secretRows } = await withServiceRole(dbPool, (db) =>
      db.query<NiaSecretRow>(
        `select ciphertext, encrypted_data_key, iv, auth_tag, algorithm, key_version from public.nia_secrets where id = $1`,
        [ref],
      ),
    );
    const secretRow = secretRows[0];
    if (!secretRow) throw new HttpError(404, "secret not found");

    const masterKey = parseMasterKey(process.env.NIA_SECRET_MASTER_KEY);
    const encrypted: EncryptedSecret = {
      ciphertext: secretRow.ciphertext,
      encryptedDataKey: secretRow.encrypted_data_key,
      iv: secretRow.iv,
      authTag: secretRow.auth_tag,
      algorithm: secretRow.algorithm,
      keyVersion: secretRow.key_version,
    };
    const secret = decryptSecret(masterKey, encrypted);

    // log_connection_audit (0027) is granted to service_role too, but a
    // service_role caller has no auth.uid() — it requires an explicit
    // actor. The agent's own created_by_user_id is the closest "who
    // authorized this" attribution, same posture as revoke_agent's audit
    // call. Detail carries only the setup id, never the secret.
    await withServiceRole(dbPool, (db) =>
      db.query(`select public.log_connection_audit($1, 'connection.secret_fetched_by_agent', $2::jsonb, $3)`, [
        setup.destination_connection_id,
        JSON.stringify({ agentSetupId: req.params.id }),
        agent.createdByUserId,
      ]),
    );

    return secret;
  });

  // Slice R3a (B.4) — the agent reports a setup applied at a version, or
  // rejected with a short reason. Applying clears any previous rejection;
  // rejecting leaves applied_version untouched.
  app.post<{ Params: { id: string } }>("/agent-api/setups/:id/report", async (req) => {
    const agentKey = extractAgentKey(req.headers.authorization);
    const agent = await resolveAgentFromKey(agentKey);
    if (!agent) throw new HttpError(401, "agent key is invalid or revoked");

    const { appliedVersion, rejectionReason } = SetupReportBody.parse(req.body);

    const { rows } = await withServiceRole(dbPool, (db) =>
      db.query<{ id: string; workflow_id: string | null }>(
        `update public.agent_setups
           set applied_version = coalesce($3, applied_version),
               rejection_reason = $4,
               updated_at = now()
         where id = $1 and source = 'platform' and agent_id = $2
         returning id, workflow_id`,
        [req.params.id, agent.id, appliedVersion ?? null, rejectionReason ?? null],
      ),
    );
    const updated = rows[0];
    if (!updated) throw new HttpError(404, "setup not found");

    // Safeguards slice: agent_setup.rejected audit entry — who (there's no
    // acting user here, this is the agent itself reporting; attributed to
    // the agent's own created_by_user_id, same posture as the secret-fetch
    // audit above), when (created_at default), which org/workspace
    // (agent.orgId xor agent.ownerId), which workflow (workflow_id), and
    // the agent's own reason string (never a secret/row/param value — this
    // is a short human-readable rejection reason apps/agent itself wrote,
    // e.g. "destination unreachable").
    if (rejectionReason !== undefined) {
      await withServiceRole(dbPool, (db) =>
        db.query(
          `insert into public.audit_log (org_id, owner_id, actor, action, detail)
           values ($1, $2, $3, 'agent_setup.rejected', $4::jsonb)`,
          [
            agent.orgId,
            agent.ownerId,
            agent.createdByUserId,
            JSON.stringify({ workflowId: updated.workflow_id, agentSetupId: updated.id, reason: rejectionReason }),
          ],
        ),
      );
    }

    return { ok: true as const };
  });

  // Workflows screen (agent app) — Slice: list this agent's platform-
  // published workflows, a read-only sanitized graph for one, and an
  // action (run now / pause / resume) request, all scoped to
  // agent_setups.agent_id = agent.id. A workflow id for a different
  // agent/org is always a 404 here, same posture as the setup routes
  // above — never distinguishable from "doesn't exist".
  app.get("/agent-api/workflows", async (req) => {
    const agentKey = extractAgentKey(req.headers.authorization);
    const agent = await resolveAgentFromKey(agentKey);
    if (!agent) throw new HttpError(401, "agent key is invalid or revoked");

    const { rows } = await withServiceRole(dbPool, (db) =>
      db.query<{
        setup_id: string;
        workflow_id: string;
        name: string;
        wanted_version: number;
        applied_version: number;
        rejection_reason: string | null;
        platform_job_state: Record<string, unknown> | null;
      }>(
        `select s.id as setup_id, s.workflow_id, w.name, s.wanted_version, s.applied_version, s.rejection_reason, s.platform_job_state
         from public.agent_setups s
         join public.workflows w on w.id = s.workflow_id
         where s.agent_id = $1 and s.source = 'platform' and s.unpublished_at is null
         order by w.name asc`,
        [agent.id],
      ),
    );
    if (rows.length === 0) return { workflows: [] as unknown[] };

    const { rows: runRows } = await withServiceRole(dbPool, (db) =>
      db.query<{
        agent_setup_id: string;
        status: "ok" | "failed";
        finished_at: string;
        // bigint column — pg returns this as a string, not a number
        rows_sent: string;
        error_class: string | null;
      }>(
        `select distinct on (agent_setup_id) agent_setup_id, status, finished_at, rows_sent, error_class
         from public.agent_setup_runs
         where agent_setup_id = any($1::uuid[])
         order by agent_setup_id, started_at desc`,
        [rows.map((row) => row.setup_id)],
      ),
    );
    const lastRunBySetupId = new Map(runRows.map((run) => [run.agent_setup_id, run]));

    return {
      workflows: rows.map((row) => {
        const derived = deriveWorkflowStatus(row);
        const lastRun = lastRunBySetupId.get(row.setup_id);
        return {
          workflowId: row.workflow_id,
          setupId: row.setup_id,
          name: row.name,
          status: derived.status,
          errorClass: derived.errorClass,
          rejectionReason: derived.rejectionReason,
          nextRunAt: derived.nextRunAt,
          lastRun: lastRun
            ? { status: lastRun.status, finishedAt: lastRun.finished_at, rowsSent: Number(lastRun.rows_sent), errorClass: lastRun.error_class }
            : null,
        };
      }),
    };
  });

  // Run history for the detail screen — same columns/ordering/limit as
  // apps/api's listAgentSetupRuns (agentSetupActions.ts), scoped the same
  // "mine only" way as every other route here instead of assertWorkflowInScope.
  app.get<{ Params: { workflowId: string }; Querystring: { limit?: string } }>(
    "/agent-api/workflows/:workflowId/runs",
    async (req) => {
      const agentKey = extractAgentKey(req.headers.authorization);
      const agent = await resolveAgentFromKey(agentKey);
      if (!agent) throw new HttpError(401, "agent key is invalid or revoked");

      const { rows: setupRows } = await withServiceRole(dbPool, (db) =>
        db.query<{ id: string }>(
          `select id from public.agent_setups
           where workflow_id = $1 and agent_id = $2 and source = 'platform' and unpublished_at is null`,
          [req.params.workflowId, agent.id],
        ),
      );
      if (setupRows.length === 0) throw new HttpError(404, "workflow not found");

      const limit = Math.min(Math.max(Number(req.query.limit ?? 20) || 20, 1), 50);
      const { rows } = await withServiceRole(dbPool, (db) =>
        db.query<{
          id: string;
          run_id: string;
          status: "ok" | "failed";
          // bigint columns — pg returns these as strings, not numbers
          rows_sent: string;
          rows_deleted: string;
          mode: string | null;
          duration_ms: number;
          error_class: string | null;
          started_at: string;
          finished_at: string;
        }>(
          `select r.id, r.run_id, r.status, r.rows_sent, r.rows_deleted, r.mode, r.duration_ms, r.error_class, r.started_at, r.finished_at
           from public.agent_setup_runs r
           where r.agent_setup_id = $1
           order by r.started_at desc
           limit $2`,
          [setupRows[0]!.id, limit],
        ),
      );

      return {
        runs: rows.map((row) => ({
          id: row.id,
          runId: row.run_id,
          status: row.status,
          rowsSent: Number(row.rows_sent),
          rowsDeleted: Number(row.rows_deleted),
          mode: row.mode,
          durationMs: row.duration_ms,
          errorClass: row.error_class,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
        })),
      };
    },
  );

  app.get<{ Params: { workflowId: string } }>("/agent-api/workflows/:workflowId/graph", async (req) => {
    const agentKey = extractAgentKey(req.headers.authorization);
    const agent = await resolveAgentFromKey(agentKey);
    if (!agent) throw new HttpError(401, "agent key is invalid or revoked");

    const { rows: setupRows } = await withServiceRole(dbPool, (db) =>
      db.query<{ id: string }>(
        `select id from public.agent_setups
         where workflow_id = $1 and agent_id = $2 and source = 'platform' and unpublished_at is null`,
        [req.params.workflowId, agent.id],
      ),
    );
    if (setupRows.length === 0) throw new HttpError(404, "workflow not found");

    const { rows: graphRows } = await withServiceRole(dbPool, (db) =>
      db.query<{ graph: unknown; version: number }>(`select graph, version from public.workflow_graphs where workflow_id = $1`, [
        req.params.workflowId,
      ]),
    );
    const graphRow = graphRows[0];
    const graph: GraphDocType = graphRow ? GraphDoc.parse(graphRow.graph) : GraphDoc.parse({});

    const connectionIds = [...new Set(graph.nodes.map((node) => node.connectionId).filter((id): id is string => Boolean(id)))];
    const connRows = connectionIds.length
      ? (
          await withServiceRole(dbPool, (db) =>
            db.query<{ id: string; display_name: string; config: Record<string, unknown> }>(
              `select id, display_name, config from public.connections where id = any($1::uuid[])`,
              [connectionIds],
            ),
          )
        ).rows
      : [];
    const connectionsById = new Map(connRows.map((row) => [row.id, row]));

    return {
      workflowId: req.params.workflowId,
      version: graphRow?.version ?? 0,
      nodes: graph.nodes.map((node) => mapGraphNodeForAgent(node, connectionsById)),
      edges: graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
      })),
    };
  });

  app.post<{ Params: { workflowId: string } }>("/agent-api/workflows/:workflowId/actions", async (req, reply) => {
    const agentKey = extractAgentKey(req.headers.authorization);
    const agent = await resolveAgentFromKey(agentKey);
    if (!agent) throw new HttpError(401, "agent key is invalid or revoked");

    // `.strict()` rejects an `allowMassDelete` key outright (see comment on
    // WorkflowActionBody above) — surfaced here as a deliberate 400 rather
    // than left to fall through as an uncaught ZodError (which Fastify's
    // default handler would otherwise serialize as a 500).
    const parsed = WorkflowActionBody.safeParse(req.body);
    if (!parsed.success) {
      if (
        parsed.error.issues.some(
          (issue) => issue.code === "unrecognized_keys" && issue.keys.includes("allowMassDelete"),
        )
      ) {
        return reply.code(400).send({ kind: "badRequest", message: "Mass-delete approval is only possible on the website." });
      }
      throw parsed.error;
    }
    const body = parsed.data;

    // A `resume` requested from the agent app must never lift a pause
    // that was caused by the mass-delete guard — that guard exists
    // specifically so a human reviews the affected rows on the website
    // (which has the review UI) before overriding it; the agent app has
    // no such review step, so this path is blocked outright rather than
    // silently resuming into a dangerous run. A workflow this agent
    // doesn't own looks identical to "not paused" here (no rows), which
    // is fine — it still 404s a line further down once the RPC itself
    // can't find a matching setup.
    if (body.kind === "resume") {
      const { rows: stateRows } = await withServiceRole(dbPool, (db) =>
        db.query<{ platform_job_state: Record<string, unknown> | null }>(
          `select platform_job_state from public.agent_setups
           where workflow_id = $1 and agent_id = $2 and source = 'platform' and unpublished_at is null`,
          [req.params.workflowId, agent.id],
        ),
      );
      const jobState = stateRows[0]?.platform_job_state;
      if (jobState?.["state"] === "paused" && jobState?.["errorClass"] === "massDelete") {
        throw new HttpError(403, "paused by the mass-delete guard — review and resume from the website");
      }
    }

    // Reuses the exact guard+insert+notify logic the website's own
    // create_agent_setup_action_task RPC delegates to (0077, private
    // helper scoped by agent_id + workflow_id) — a workflow/agent pair
    // with no matching published setup, or an unsupported kind, raises
    // inside the function and lands here as a 404. `allowMassDelete` is
    // never sent here (rejected by WorkflowActionBody above), so the
    // helper's own mass-delete override branch can never be reached from
    // this route.
    let taskId: string;
    try {
      const { rows } = await withServiceRole(dbPool, (db) =>
        db.query<{ id: string }>(`select id from private.create_agent_setup_action_task($1, $2, $3, $4::jsonb)`, [
          agent.id,
          req.params.workflowId,
          body.kind,
          JSON.stringify({ params: body.params, fullReload: body.fullReload }),
        ]),
      );
      taskId = rows[0]?.id ?? "";
    } catch {
      throw new HttpError(404, "workflow not found");
    }
    if (!taskId) throw new HttpError(404, "workflow not found");

    // Distinct action name from the website's own agent_setup.action_requested
    // (0074/0076's RPC path) so the two sources are always distinguishable
    // in the trail, attributed to the agent's created_by_user_id (no real
    // acting user session here) with the requesting host — never a
    // param value, same "never a secret/row/param value" rule as 0076.
    await withServiceRole(dbPool, (db) =>
      db.query(
        `insert into public.audit_log (org_id, owner_id, actor, action, detail)
         values ($1, $2, $3, 'agent_setup.action_requested_by_agent', $4::jsonb)`,
        [
          agent.orgId,
          agent.ownerId,
          agent.createdByUserId,
          JSON.stringify({
            workflowId: req.params.workflowId,
            kind: body.kind,
            fullReload: body.fullReload,
            hostName: agent.hostName,
          }),
        ],
      ),
    );

    return { ok: true as const };
  });

  return app;
}
