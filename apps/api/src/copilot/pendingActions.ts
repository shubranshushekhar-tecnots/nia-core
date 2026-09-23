import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../lib/appError.js";

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
  supabase: SupabaseClient,
  workflowId: string,
  tool: string,
  args: unknown,
): Promise<PendingAction> {
  const { data, error } = await supabase
    .from("copilot_pending_actions")
    .insert({ workflow_id: workflowId, tool, args_hash: hashToolArgs(tool, args), args })
    .select("id, workflow_id, tool, args_hash, args, created_at, expires_at, confirmed_at, confirmed_by, consumed_at")
    .single();
  if (error || !data) throw new AppError(500, "PENDING_ACTION_WRITE_FAILED", error?.message ?? "Failed to create a pending action.");
  return toPendingAction(data as PendingActionRow);
}

export async function getPendingAction(supabase: SupabaseClient, id: string): Promise<PendingAction | null> {
  const { data } = await supabase
    .from("copilot_pending_actions")
    .select("id, workflow_id, tool, args_hash, args, created_at, expires_at, confirmed_at, confirmed_by, consumed_at")
    .eq("id", id)
    .maybeSingle();
  return data ? toPendingAction(data as PendingActionRow) : null;
}

/**
 * Only callable from the user-session confirm endpoint (routes/
 * copilotAgent.ts's POST .../pending-actions/:id/confirm) — never from the
 * agent loop itself. The rpc it calls (confirm_pending_action) is the sole
 * write path for confirmed_at/confirmed_by (see 0031's header comment);
 * this function does nothing more than call it and translate the error.
 */
export async function confirmPendingAction(supabase: SupabaseClient, id: string): Promise<PendingAction> {
  const { data, error } = await supabase.rpc("confirm_pending_action", { p_id: id }).single();
  if (error || !data) throw new AppError(409, "PENDING_ACTION_CONFIRM_FAILED", error?.message ?? "Could not confirm this action.");
  return toPendingAction(data as PendingActionRow);
}

/**
 * Called by an execute-tier tool handler (never anything else) right
 * before doing the real work — the tool+argsHash match required by the
 * consume_pending_action rpc is what stops a confirmed pending action from
 * being replayed against different arguments than what was confirmed.
 */
export async function consumePendingAction(
  supabase: SupabaseClient,
  id: string,
  tool: string,
  args: unknown,
): Promise<PendingAction> {
  const { data, error } = await supabase
    .rpc("consume_pending_action", { p_id: id, p_tool: tool, p_args_hash: hashToolArgs(tool, args) })
    .single();
  if (error || !data) {
    throw new AppError(
      409,
      "PENDING_ACTION_NOT_CONFIRMED",
      error?.message ?? "This action needs to be confirmed before it can run.",
    );
  }
  return toPendingAction(data as PendingActionRow);
}
