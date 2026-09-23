import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";
import type { UserContext } from "../lib/actorTypes.js";
import type { WorkspaceScope } from "../lib/workspaceScope.js";

/**
 * Copilot agent (docs/plans/copilot-agent.md, Part 1). Risk tier a tool
 * carries — governs whether the agent loop may call it outright (read),
 * must show a diff/ghost preview (edit), or must go through a confirmed
 * pending action first (execute). See registry.ts for the runtime check
 * that makes a tool missing its tier fail loud, and copilot.md's Part 2
 * for the full v1 tool list per tier.
 */
export type ToolTier = "read" | "edit" | "execute";

/**
 * The signed-in user a tool call runs as — always derived from the same
 * getActingUser() helper (actingUser.ts) used by every tool handler, the
 * confirmation endpoint, and the audit log call, per Part 1's "route the
 * acting user's identity through a single helper" requirement.
 */
export type ActingUser = {
  userId: string;
  scope: WorkspaceScope;
  actor: UserContext;
};

/**
 * What a tool handler gets to act with. `supabase` is always the caller's
 * own per-request, RLS-scoped client — never a service-role client (Part
 * 1: "Copilot never uses the service-role key"). `pendingActionId` is only
 * present on an execute-tier call and is threaded through to the handler
 * so it can call consume_pending_action itself (see startRun.ts).
 */
export type ToolContext = {
  supabase: SupabaseClient;
  user: ActingUser;
  pendingActionId?: string;
};

/**
 * `summarize` is what the model sees on the next turn of the agent loop —
 * this is the data-minimization boundary (Part 4): preview_rows/
 * get_run_result's `summarize` must never include the actual row values,
 * only counts/columns/types, so the full output only ever reaches the
 * user via `render`. `render` is a plain description of what the UI shows
 * for this tool's result — the actual React rendering lives in apps/web;
 * this is a structural hint (kind + a JSON-safe payload) the API response
 * carries so the client can pick the right card without re-deriving it
 * from the tool name alone.
 */
export type ToolRender = { kind: string; payload: unknown };

export type ToolDefinition<TInput, TOutput> = {
  name: string;
  description: string;
  tier: ToolTier;
  inputSchema: z.ZodType<TInput>;
  handler: (ctx: ToolContext, input: TInput) => Promise<TOutput>;
  /** One-line-ish string handed back to the LLM as the tool result — never the raw output. */
  summarize: (output: TOutput, input: TInput) => string;
  /** Structural hint for the UI renderer — never derived from model-authored text. */
  render: (output: TOutput, input: TInput) => ToolRender;
};

/** Type-erased shape the registry stores tools as, so a heterogeneous map of ToolDefinition<X, Y> is possible. */
export type AnyToolDefinition = ToolDefinition<unknown, unknown>;
