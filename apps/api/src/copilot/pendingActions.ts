import { createHash } from "node:crypto";
import { AppError } from "../lib/appError.js";
import type { WithUser } from "../lib/withUser.js";

/**
 * Copilot agent (Part 3): the confirmation mechanism an execute-tier tool
 * call must go through. Hashing is canonical (sorted keys) so the same
 * logical arguments always hash the same way regardless of key order —
 * the hash is the thing consume_pending_action checks still matches at
 * execution time (0031_copilot_agent.sql's header comment).
 */
function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashToolArgs(tool: string, args: unknown): string {
  return createHash("sha256").update(`${tool}:${canonicalStringify(args)}`).digest("hex");
}

export type PendingAction = {
  id: string;
  workflowId: string;
  tool: string;
  argsHash: string;
  args: unknown;
  createdAt: string;
  expiresAt: string;
  confirmedAt: string | null;
  confirmedBy: string | null;
  consumedAt: string | null;
};

type PendingActionRow = {
  id: string;
  workflow_id: string;
  tool: string;
  args_hash: string;
  args: unknown;
  created_at: string;
  expires_at: string;
  confirmed_at: string | null;
  confirmed_by: string | null;
  consumed_at: string | null;
};

function toPendingAction(row: PendingActionRow): PendingAction {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    tool: row.tool,
    argsHash: row.args_hash,
    args: row.args,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    confirmedAt: row.confirmed_at,
    confirmedBy: row.confirmed_by,
    consumedAt: row.consumed_at,
  };
}

/** Created by an execute-tier tool's handler, before it refuses to proceed — see startRun.ts. */
export async function createPendingAction(
  withUser: WithUser,
  workflowId: string,
  tool: string,
  args: unknown,
): Promise<PendingAction> {
  try {
    const { rows } = await withUser((db) =>
      db.query<PendingActionRow>(
        `insert into public.copilot_pending_actions (workflow_id, tool, args_hash, args)
         values ($1, $2, $3, $4)
         returning id, workflow_id, tool, args_hash, args, created_at, expires_at, confirmed_at, confirmed_by, consumed_at`,
        [workflowId, tool, hashToolArgs(tool, args), args],
      ),
    );
    const row = rows[0];
    if (!row) throw new AppError(500, "PENDING_ACTION_WRITE_FAILED", "Failed to create a pending action.");
    return toPendingAction(row);
  } catch (err) {
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new AppError(500, "PENDING_ACTION_WRITE_FAILED", message);
  }
}

export async function getPendingAction(withUser: WithUser, id: string): Promise<PendingAction | null> {
  const { rows } = await withUser((db) =>
    db.query<PendingActionRow>(
      `select id, workflow_id, tool, args_hash, args, created_at, expires_at, confirmed_at, confirmed_by, consumed_at
       from public.copilot_pending_actions
       where id = $1`,
      [id],
    ),
  );
  return rows[0] ? toPendingAction(rows[0]) : null;
}

/**
 * Only callable from the user-session confirm endpoint (routes/
 * copilotAgent.ts's POST .../pending-actions/:id/confirm) — never from the
 * agent loop itself. The rpc it calls (confirm_pending_action) is the sole
 * write path for confirmed_at/confirmed_by (see 0031's header comment);
 * this function does nothing more than call it and translate the error.
 */
export async function confirmPendingAction(withUser: WithUser, id: string): Promise<PendingAction> {
  try {
    const { rows } = await withUser((db) => db.query<PendingActionRow>("select * from public.confirm_pending_action($1)", [id]));
    const row = rows[0];
    if (!row) throw new AppError(409, "PENDING_ACTION_CONFIRM_FAILED", "Could not confirm this action.");
    return toPendingAction(row);
  } catch (err) {
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new AppError(409, "PENDING_ACTION_CONFIRM_FAILED", message);
  }
}

/**
 * Called by an execute-tier tool handler (never anything else) right
 * before doing the real work — the tool+argsHash match required by the
 * consume_pending_action rpc is what stops a confirmed pending action from
 * being replayed against different arguments than what was confirmed.
 */
export async function consumePendingAction(
  withUser: WithUser,
  id: string,
  tool: string,
  args: unknown,
): Promise<PendingAction> {
  try {
    const { rows } = await withUser((db) =>
      db.query<PendingActionRow>("select * from public.consume_pending_action($1, $2, $3)", [id, tool, hashToolArgs(tool, args)]),
    );
    const row = rows[0];
    if (!row) throw new AppError(409, "PENDING_ACTION_NOT_CONFIRMED", "This action needs to be confirmed before it can run.");
    return toPendingAction(row);
  } catch (err) {
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new AppError(409, "PENDING_ACTION_NOT_CONFIRMED", message);
  }
}
