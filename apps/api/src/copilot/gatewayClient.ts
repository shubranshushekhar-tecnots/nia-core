import OpenAI from "openai";
import type { WorkspaceScope } from "@nia/db";
import { recordLlmUsage } from "@nia/db";
import { env } from "../env.js";
import { dbPool } from "../lib/dbPool.js";

/**
 * Copilot agent (docs/plans/copilot-agent.md, Part 1/4) — apps/api's own
 * thin wrapper around the official `openai` SDK pointed at the Nia Gateway,
 * used only by the agent tool-use loop (agentLoop.ts). Deliberately a
 * separate client from apps/worker's lib/llm/gatewayClient.ts, not a shared
 * package: this one only ever needs a single tool-calling chat-completion
 * call, and duplicating the ~20 lines here avoids pulling apps/worker's
 * Langfuse observability wrapper (recordGeneration) into apps/api, which has
 * no existing Langfuse wiring — out of scope for this plan. If Copilot's
 * LLM calls need tracing later, that's a follow-up, not a blocker here.
 *
 * It DOES record one llm_usage row per call (Console v2 token usage ledger,
 * packages/db/src/llmUsage.ts, feature "copilot_agent") via the same
 * recordLlmUsage apps/worker uses — recordLlmUsage never throws, so a
 * recording failure can never break the underlying LLM call. recordLlmUsage
 * writes via withServiceRole (llm_usage has zero grants to
 * authenticated/anon, by design, same posture as platform_staff) — this is
 * the same "deliberate, narrow exception" to apps/api's general
 * never-withServiceRole rule (dbPool.ts's header comment) that
 * requireStaff.ts and billingWebhook.ts already establish: there is no
 * RLS-governed read/write here, just an append-only system ledger insert
 * with no acting-user-shaped equivalent.
 */
const client = new OpenAI({
  apiKey: env.NIA_GATEWAY_API_KEY,
  baseURL: env.NIA_GATEWAY_BASE_URL,
});

export type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;
export type ToolSpec = OpenAI.Chat.ChatCompletionTool;
export type ToolCall = OpenAI.Chat.ChatCompletionMessageToolCall;

export type CompletionResult = {
  content: string | null;
  toolCalls: ToolCall[];
};

/** Attribution for the llm_usage ledger — the acting user's scope + id, required on every call. */
export type LlmCallContext = {
  scope: WorkspaceScope;
  userId: string;
};

function errorCodeOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

/**
 * The agent loop's only LLM call site. Always temperature 0 (plan
 * requirement — deterministic tool selection, no per-call-site override),
 * always `tool_choice: "auto"` so the model can also choose to just answer
 * in plain text and stop.
 */
export async function completeWithTools(messages: ChatMessage[], tools: ToolSpec[], context: LlmCallContext): Promise<CompletionResult> {
  const startTime = Date.now();
  let res;
  try {
    // An empty `tools` array (agentLoop.ts's final, no-more-tool-calls
    // request after hitting MAX_TOOL_CALLS) is invalid alongside
    // tool_choice: "auto" for some gateways — omit both fields entirely in
    // that case rather than sending an empty array.
    res = await client.chat.completions.create({
      model: env.NIA_GATEWAY_MODEL,
      messages,
      temperature: 0,
      ...(tools.length > 0 ? { tools, tool_choice: "auto" as const } : {}),
    });
  } catch (err) {
    await recordLlmUsage(dbPool, {
      scope: context.scope,
      userId: context.userId,
      feature: "copilot_agent",
      model: env.NIA_GATEWAY_MODEL,
      latencyMs: Date.now() - startTime,
      status: "error",
      errorCode: errorCodeOf(err),
    });
    throw err;
  }
  const message = res.choices[0]?.message;
  await recordLlmUsage(dbPool, {
    scope: context.scope,
    userId: context.userId,
    feature: "copilot_agent",
    model: env.NIA_GATEWAY_MODEL,
    latencyMs: Date.now() - startTime,
    status: "ok",
    usage: res.usage
      ? { inputTokens: res.usage.prompt_tokens, outputTokens: res.usage.completion_tokens, totalTokens: res.usage.total_tokens }
      : undefined,
  });
  return {
    content: message?.content ?? null,
    toolCalls: message?.tool_calls ?? [],
  };
}
