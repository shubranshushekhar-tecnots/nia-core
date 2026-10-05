import Fastify from "fastify";
import { z } from "zod";
import { withServiceRole } from "@nia/db";
import { dbPool } from "./db.js";
import { generateAgentKey, sha256Hex } from "./crypto.js";
import { LongPollTransport, type AgentTransport } from "./transport.js";

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

const CheckInBody = z
  .object({
    agentVersion: z.string().optional(),
    hostName: z.string().optional(),
  })
  .optional();

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
export function buildApp(transport: AgentTransport = new LongPollTransport()) {
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({ status: "ok" as const, service: "agent-bridge" }));

  // docs/plans/agent-canvas-integration.md B.12: {pairingCodeId, code} — the
  // id is a non-secret lookup key (lets consume_agent_pairing_code count
  // wrong attempts per-row without the lookup itself being a guessable
  // oracle), the code is the one-time secret, hashed here before ever
  // reaching Postgres (consume_agent_pairing_code only ever sees the hash).
  app.post("/pair", async (req) => {
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
  app.post("/check-in", async (req) => {
    const authHeader = req.headers.authorization ?? "";
    const agentKey = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
    if (!agentKey) throw new HttpError(401, "missing agent key");

    const { agentVersion, hostName } = CheckInBody.parse(req.body) ?? {};
    const agentKeyHash = sha256Hex(agentKey);

    const { rows } = await withServiceRole(dbPool, (db) =>
      db.query<AgentRow>(
        `update public.platform_agents
           set last_check_in_at = now(),
               agent_version = coalesce($2, agent_version),
               host_name = coalesce($3, host_name)
         where agent_key_hash = $1 and status <> 'revoked'
         returning id, status`,
        [agentKeyHash, agentVersion ?? null, hostName ?? null],
      ),
    );
    const agent = rows[0];
    if (!agent) throw new HttpError(401, "agent key is invalid or revoked");

    const tasks = await transport.waitForTasks(agent.id, CHECK_IN_HOLD_MS);
    return { tasks };
  });

  return app;
}
