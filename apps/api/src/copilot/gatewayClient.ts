import OpenAI from "openai";
import { env } from "../env.js";

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

/**
 * The agent loop's only LLM call site. Always temperature 0 (plan
 * requirement — deterministic tool selection, no per-call-site override),
 * always `tool_choice: "auto"` so the model can also choose to just answer
 * in plain text and stop.
 */
export async function completeWithTools(messages: ChatMessage[], tools: ToolSpec[]): Promise<CompletionResult> {
  // An empty `tools` array (agentLoop.ts's final, no-more-tool-calls
  // request after hitting MAX_TOOL_CALLS) is invalid alongside
  // tool_choice: "auto" for some gateways — omit both fields entirely in
  // that case rather than sending an empty array.
  const res = await client.chat.completions.create({
    model: env.NIA_GATEWAY_MODEL,
    messages,
    temperature: 0,
    ...(tools.length > 0 ? { tools, tool_choice: "auto" as const } : {}),
  });
  const message = res.choices[0]?.message;
  return {
    content: message?.content ?? null,
    toolCalls: message?.tool_calls ?? [],
  };
}
