import { randomInt, createHash } from "node:crypto";
import { assertCanManageAgent, type ActorRole } from "@nia/schemas";
import type { WorkspaceScope } from "../lib/workspaceScope.js";
import { AppError } from "../lib/appError.js";
import type { WithUser } from "../lib/withUser.js";

/**
 * docs/plans/agent-canvas-integration.md B.2/B.12 — platform side of Slice
 * 1 ("Link"). "online"/"offline" is derived here (last_check_in_at vs. a
 * threshold), not a stored column — see 0069_platform_agents.sql's header.
 * The bridge's /check-in hold defaults to 25s (AGENT_CHECK_IN_HOLD_MS in
 * services/agent-bridge); 3x that comfortably covers one missed poll
 * before flipping to offline.
 */
const ONLINE_THRESHOLD_MS = 90_000;

export type PlatformAgent = {
  id: string;
  displayName: string;
  status: "pending" | "active" | "revoked";
  agentVersion: string | null;
  hostName: string | null;
  lastCheckInAt: string | null;
  createdByUserId: string;
  createdAt: string;
  online: boolean;
};

type AgentRow = {
  id: string;
  display_name: string;
  status: "pending" | "active" | "revoked";
  agent_version: string | null;
  host_name: string | null;
  last_check_in_at: string | null;
  created_by_user_id: string;
  created_at: string;
};

const AGENTS_SELECT =
  "id, display_name, status, agent_version, host_name, last_check_in_at, created_by_user_id, created_at";

function toAgent(row: AgentRow): PlatformAgent {
  const online =
    row.last_check_in_at !== null && Date.now() - new Date(row.last_check_in_at).getTime() < ONLINE_THRESHOLD_MS;
  return {
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    agentVersion: row.agent_version,
    hostName: row.host_name,
    lastCheckInAt: row.last_check_in_at,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    online,
  };
}

/**
 * RLS (platform_agents_select_members) already scopes this to the caller's
 * own org/personal workspace — a member of another org gets zero rows back,
 * never a 403, same as every other RLS-scoped list in this codebase.
 */
export async function listAgents(withUser: WithUser): Promise<PlatformAgent[]> {
  const { rows } = await withUser((db) =>
    db.query<AgentRow>(`select ${AGENTS_SELECT} from platform_agents order by created_at desc`),
  );
  return rows.map(toAgent);
}

const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // excludes 0/O/1/I (B.12)

function generatePairingCode(): string {
  let code = "";
  for (let i = 0; i < 8; i++) code += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
  return code;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The raw code is generated and hashed here (Node), never in Postgres —
 * create_agent_pairing_code only ever sees the hash (0069's header comment).
 * Returned once; the caller (apps/web) is responsible for displaying it.
 */
export async function createPairingCode(
  withUser: WithUser,
  scope: WorkspaceScope,
  displayName?: string,
): Promise<{ pairingCodeId: string; code: string; expiresAt: string }> {
  const code = generatePairingCode();
  const codeHash = sha256Hex(code);

  try {
    const { rows } = await withUser((db) =>
      db.query<{ id: string; expires_at: string }>(
        "select id, expires_at from public.create_agent_pairing_code($1, $2, $3, $4)",
        [
          "orgId" in scope ? scope.orgId : null,
          "ownerId" in scope ? scope.ownerId : null,
          codeHash,
          displayName ?? null,
        ],
      ),
    );
    const row = rows[0];
    if (!row) throw new AppError(500, "CREATE_FAILED", "Failed to create pairing code.");
    return { pairingCodeId: row.id, code, expiresAt: row.expires_at };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(500, "CREATE_FAILED", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Fetches the specific agent row first (RLS-scoped, so a member of another
 * org gets NOT_FOUND here, never reaching the authorization check below)
 * then layers assertCanManageAgent for a fast, typed error — mirrors
 * apps/web/src/lib/members/actions.ts's direct assertCanManageMember call.
 * revoke_agent itself re-checks private.can_manage_agent server-side
 * regardless (defense-in-depth, same posture as every other RPC here).
 */
export async function revokeAgent(
  withUser: WithUser,
  actorRole: ActorRole,
  actorUserId: string,
  agentId: string,
): Promise<PlatformAgent> {
  const { rows } = await withUser((db) =>
    db.query<AgentRow>(`select ${AGENTS_SELECT} from platform_agents where id = $1`, [agentId]),
  );
  const row = rows[0];
  if (!row) throw new AppError(404, "NOT_FOUND", "Agent not found.");

  assertCanManageAgent(actorRole, actorUserId, row.created_by_user_id);

  try {
    const { rows: revokedRows } = await withUser((db) =>
      db.query<AgentRow>("select * from public.revoke_agent($1)", [agentId]),
    );
    const revokedRow = revokedRows[0];
    if (!revokedRow) throw new AppError(409, "REVOKE_FAILED", "Could not revoke this agent.");
    return toAgent(revokedRow);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(409, "REVOKE_FAILED", err instanceof Error ? err.message : String(err));
  }
}
