import Fastify from "fastify";
import { TestRequest, IntrospectRequest, ExecuteRequest, WriteRequest, type ReadContext } from "@nia/schemas";
import { withServiceRole } from "@nia/db";
import { dbPool } from "./db.js";
import { verifyReadContext, HttpError } from "./writeSignature.js";
import { taskBus } from "./taskBus.js";

/**
 * Slice C1 — the bridge's *internal* listener (never published through
 * nginx or docker-compose's `ports:`, see index.ts's header comment on the
 * second app.listen() call). This is what apps/api's connectorDispatch.ts
 * actually talks to for the `sqlserver_agent` connector, the exact same
 * contract shape every other connector service (connector-mysql etc.)
 * exposes — /test, /introspect, /execute — just routed through a live agent
 * instead of a direct DB pool.
 *
 * A separate buildInternalApp() factory (mirrors app.ts's buildApp()) so
 * tests can app.inject() against it directly without binding a real port.
 */

// Same clock-skew-tolerant style as every other connector's verifyReadRequest
// (services/connector-mysql/src/index.ts) — duplicated per-service by
// convention (see writeSignature.ts's header), route is always the literal
// call-site string, never taken from the request body.
function verifyReadRequest(route: "test" | "introspect", connectionId: string, context: ReadContext): void {
  const secret = process.env.WRITE_DISPATCH_SIGNING_SECRET;
  if (!secret) throw new Error("WRITE_DISPATCH_SIGNING_SECRET is not configured");
  const valid = verifyReadContext({ route, connectionId, queryPayload: null, issuedAt: context.issuedAt }, context.signature, secret);
  if (!valid) throw new HttpError(401, "read context signature is invalid or expired");
}

type ConnectionRow = {
  org_id: string | null;
  owner_id: string | null;
  config: Record<string, unknown>;
};

type AgentRow = {
  id: string;
  org_id: string | null;
  owner_id: string | null;
  status: "pending" | "active" | "revoked";
  last_check_in_at: string | null;
};

type ResolvedAgentConnection = {
  agentId: string;
  localConnectionId: string;
  agentStatus: AgentRow["status"];
  lastCheckInAt: string | null;
};

// Duplicated from apps/api/src/services/agents.ts's ONLINE_THRESHOLD_MS by
// the same "never import across service boundaries" convention as
// writeSignature.ts — this is the bridge's own online/offline read, derived
// the same way, not a shared constant.
const ONLINE_THRESHOLD_MS = 90_000;

const TASK_TIMEOUT_MS: Record<"test_connection" | "list_tables", number> = {
  // test_connection stays strictly shorter than apps/api's 15000ms /test
  // dispatch timeout so the bridge always answers before the caller gives
  // up waiting. list_tables raised to 45s (Slice R1, requirement 6) to
  // match apps/api's introspect timeout (now 60s, see connectorDispatch.ts)
  // having room to browse a large catalog.
  test_connection: 8_000,
  list_tables: 45_000,
};

// Slice R1, requirement 4 — planometry-table and https-endpoint are
// destinations whose manifest.service also points at this same bridge
// (reusing the one internal listener rather than standing up a new
// microservice), but neither is actually deliverable through an agent:
// their /test and /introspect are answered directly by apps/api
// (connections.ts), and nothing in this codebase yet drives real agent-
// relayed reads/writes for them. /execute and /write below look the
// connection's connector_id up and refuse early with a message distinct
// from the generic "not implemented yet" 501 every other connector_id
// gets, so a caller can tell "this will never work for this destination"
// apart from "this isn't built yet".
const AGENT_DELIVERED_CONNECTOR_IDS = new Set(["planometry-table", "https-endpoint"]);

async function getConnectorId(connectionId: string): Promise<string | null> {
  return withServiceRole(dbPool, async (db) => {
    const { rows } = await db.query<{ connector_id: string }>(`select connector_id from public.connections where id = $1`, [
      connectionId,
    ]);
    return rows[0]?.connector_id ?? null;
  });
}

/**
 * Resolution rule (plan point 3): never trusts an agentId/agentConnectionId
 * that might also be present in the request's own `config` payload — looks
 * the connection up by id (service role) and reads its stored
 * config.agentId/config.agentConnectionId itself, then verifies the agent's
 * scope matches the connection's and that the agent still currently reports
 * that local connection (non-removed agent_reported_connections row).
 */
async function resolveAgentConnection(connectionId: string): Promise<ResolvedAgentConnection> {
  return withServiceRole(dbPool, async (db) => {
    const { rows: connRows } = await db.query<ConnectionRow>(
      `select org_id, owner_id, config from public.connections where id = $1`,
      [connectionId],
    );
    const conn = connRows[0];
    if (!conn) throw new HttpError(404, "connection not found");

    const agentId = typeof conn.config.agentId === "string" ? conn.config.agentId : null;
    const localConnectionId = typeof conn.config.agentConnectionId === "string" ? conn.config.agentConnectionId : null;
    if (!agentId || !localConnectionId) throw new HttpError(400, "connection is missing agent configuration");

    const { rows: agentRows } = await db.query<AgentRow>(
      `select id, org_id, owner_id, status, last_check_in_at from public.platform_agents where id = $1`,
      [agentId],
    );
    const agent = agentRows[0];
    if (!agent) throw new HttpError(404, "agent not found");
    if (agent.org_id !== conn.org_id || agent.owner_id !== conn.owner_id) {
      throw new HttpError(403, "agent does not belong to this connection's workspace");
    }

    const { rows: reportedRows } = await db.query(
      `select 1 from public.agent_reported_connections
       where agent_id = $1 and local_connection_id = $2 and removed_at is null`,
      [agentId, localConnectionId],
    );
    if (reportedRows.length === 0) throw new HttpError(404, "agent no longer reports this local connection");

    return { agentId, localConnectionId, agentStatus: agent.status, lastCheckInAt: agent.last_check_in_at };
  });
}

type TaskOutcome =
  | { kind: "revoked" }
  | { kind: "offline" }
  | { kind: "timedOut" }
  | { kind: "resolved"; status: "done" | "failed"; result?: unknown; errorClass?: string };

/**
 * Immediate online/offline/revoked check happens BEFORE any agent_tasks row
 * is created (plan point 2) — neither case waits for any timeout. Only once
 * the agent is confirmed online does a task get created, taskBus.wakeAgent
 * fire (so an already-held check-in returns within ms, giving the <3s
 * target), and the route wait on taskBus.awaitTaskResult.
 */
async function runAgentTask(
  kind: "test_connection" | "list_tables",
  connectionId: string,
  resolved: ResolvedAgentConnection,
): Promise<TaskOutcome> {
  if (resolved.agentStatus === "revoked") return { kind: "revoked" };
  const online =
    resolved.lastCheckInAt !== null && Date.now() - new Date(resolved.lastCheckInAt).getTime() < ONLINE_THRESHOLD_MS;
  if (!online) return { kind: "offline" };

  const timeoutMs = TASK_TIMEOUT_MS[kind];
  const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
  const { rows } = await withServiceRole(dbPool, (db) =>
    db.query<{ id: string }>(
      `insert into public.agent_tasks (agent_id, connection_id, kind, expires_at) values ($1, $2, $3, $4) returning id`,
      [resolved.agentId, connectionId, kind, expiresAt],
    ),
  );
  const taskId = rows[0]!.id;
  taskBus.wakeAgent(resolved.agentId);

  try {
    const result = await taskBus.awaitTaskResult(taskId, timeoutMs);
    return { kind: "resolved", ...result };
  } catch {
    // Best-effort — the task-results route can no longer resolve this
    // (nobody is awaiting it anymore); mark it failed so cleanup/debugging
    // sees why, but never let this secondary update affect the response.
    await withServiceRole(dbPool, (db) =>
      db.query(
        `update public.agent_tasks set status = 'failed', error_class = 'timeout', completed_at = now()
         where id = $1 and status in ('pending', 'delivered')`,
        [taskId],
      ),
    ).catch(() => {});
    return { kind: "timedOut" };
  }
}

export function buildInternalApp() {
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({ status: "ok" as const, service: "agent-bridge-internal" }));

  // TestResponse's contract (packages/schemas/src/contract.ts) is always
  // HTTP 200 with a plain {ok, error?} shape — every failure path here
  // (bad signature aside) resolves to that same shape rather than throwing,
  // mirroring connector-mysql's /test try/catch.
  app.post("/test", async (req) => {
    const { credential, context } = TestRequest.parse(req.body);
    verifyReadRequest("test", credential.connectionId, context);

    let resolved: ResolvedAgentConnection;
    try {
      resolved = await resolveAgentConnection(credential.connectionId);
    } catch (err) {
      if (err instanceof HttpError) return { ok: false, error: err.message };
      throw err;
    }

    const outcome = await runAgentTask("test_connection", credential.connectionId, resolved);
    if (outcome.kind === "revoked") return { ok: false, error: "agent was revoked" };
    if (outcome.kind === "offline") return { ok: false, error: "agent is offline" };
    if (outcome.kind === "timedOut") return { ok: false, error: "agent did not respond in time" };
    if (outcome.status === "failed") return { ok: false, error: outcome.errorClass ?? "test failed" };

    const result = outcome.result as { ok?: boolean; latencyMs?: number; error?: string } | undefined;
    return result?.error !== undefined
      ? { ok: false, error: result.error }
      : { ok: true, latencyMs: result?.latencyMs };
  });

  // IntrospectResponse has no error field (contract.ts) — failures here are
  // non-2xx + plain {message}, exactly like every other connector's
  // /introspect (thrown HttpError -> Fastify's default error handler).
  app.post("/introspect", async (req) => {
    const { credential, context } = IntrospectRequest.parse(req.body);
    verifyReadRequest("introspect", credential.connectionId, context);

    const resolved = await resolveAgentConnection(credential.connectionId);
    const outcome = await runAgentTask("list_tables", credential.connectionId, resolved);
    if (outcome.kind === "revoked") throw new HttpError(409, "agent was revoked");
    if (outcome.kind === "offline") throw new HttpError(409, "agent is offline");
    if (outcome.kind === "timedOut") throw new HttpError(504, "agent did not respond in time");
    if (outcome.status === "failed") throw new HttpError(502, outcome.errorClass ?? "list_tables failed");

    return outcome.result;
  });

  // No connector in this codebase implements /execute yet (confirmed in
  // connectorDispatch.ts's own comment) — registered now so the route
  // exists, but refuses immediately: no task created, no agent contacted.
  app.post("/execute", async (req) => {
    const { credential } = ExecuteRequest.parse(req.body);
    const connectorId = await getConnectorId(credential.connectionId);
    if (connectorId && AGENT_DELIVERED_CONNECTOR_IDS.has(connectorId)) {
      throw new HttpError(501, "this destination is delivered by an agent");
    }
    throw new HttpError(501, "reading through the agent is not available yet");
  });

  // Slice R1, requirement 4 — no connector in this codebase writes through
  // an agent yet either; this route didn't exist before this slice.
  // Registered now, same posture as /execute: no task created, no agent
  // contacted, every connector_id refuses immediately.
  app.post("/write", async (req) => {
    const { credential } = WriteRequest.parse(req.body);
    const connectorId = await getConnectorId(credential.connectionId);
    if (connectorId && AGENT_DELIVERED_CONNECTOR_IDS.has(connectorId)) {
      throw new HttpError(501, "this destination is delivered by an agent");
    }
    throw new HttpError(501, "writing through the agent is not available yet");
  });

  return app;
}
