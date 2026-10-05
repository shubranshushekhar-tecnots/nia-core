"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCan } from "@nia/schemas";
import { requireUser } from "@/lib/auth/session";
import { apiFetchServer, ApiError } from "@/lib/api/server";
import type { ActionState } from "@/lib/auth/actions";

// docs/plans/agent-canvas-integration.md Slice L3 ("Agents page").

/**
 * Carries the one-time pairing code/command through to AddAgentDialog —
 * mirrors invites/actions.ts's InviteActionState (token/link) exactly,
 * since this is the same "show a secret once, never again" shape.
 */
export type AgentActionState = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
  success?: boolean;
  pairingCodeId?: string;
  code?: string;
  expiresAt?: string;
} | null;

const pairAgentSchema = z.object({
  name: z.string().trim().min(1, "Enter a name for this agent.").max(120),
});

/**
 * The `name` field is collected for the dialog's own UX only — apps/api's
 * POST /agents/pair (services/agent-bridge's /pair handler) has no name
 * parameter yet, so it is NOT sent to the server and NOT persisted; the
 * paired agent's display_name is set by agent-bridge itself
 * ("Agent paired <timestamp>"). Threading a user-supplied name through
 * would need a new agent_pairing_codes column plus agent-bridge changes,
 * which is out of this slice's "small apps/api additions" scope — flagged
 * in the slice report rather than silently built around.
 */
export async function pairAgentAction(_prevState: AgentActionState, formData: FormData): Promise<AgentActionState> {
  const user = await requireUser();

  try {
    assertCan(user.role, "agents.pair");
  } catch {
    return { error: "You don't have permission to add an agent." };
  }

  const parsed = pairAgentSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  try {
    const result = await apiFetchServer<{ pairingCodeId: string; code: string; expiresAt: string }>("/agents/pair", {
      method: "POST",
    });
    revalidatePath("/app/agents");
    return { success: true, pairingCodeId: result.pairingCodeId, code: result.code, expiresAt: result.expiresAt };
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: "Something went wrong. Try again." };
  }
}

/**
 * Reuses the shared ActionState type (not AgentActionState) so it slots
 * directly into the existing generic DeleteConfirmDialog component without
 * modification — row-ownership ("the member who paired this agent may also
 * revoke it") is enforced authoritatively by apps/api's revokeAgent/RLS;
 * assertCan here only screens out roles that can never manage any agent.
 */
export async function revokeAgentAction(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const agentId = String(formData.get("agentId") ?? "");
  if (!agentId) return { error: "Missing agent id." };

  try {
    await apiFetchServer(`/agents/${agentId}`, { method: "DELETE" });
    revalidatePath("/app/agents");
    return { success: true };
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: "Something went wrong. Try again." };
  }
}
