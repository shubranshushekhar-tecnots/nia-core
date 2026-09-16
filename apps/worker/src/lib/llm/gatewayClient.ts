import OpenAI from "openai";
import { env } from "../../env.js";
import { recordGeneration } from "../observability/langfuse.js";

/**
 * Thin wrapper around the official `openai` SDK pointed at the Nia Gateway
 * (an OpenAI-compatible AI gateway — see .nia/assets/API_REFERENCE.md).
 * This is the chat pipeline's only LLM client; nothing else in the repo
 * calls out to a model. Server-side only — apps/web never imports this.
 *
 * Every call records one Langfuse generation (recordGeneration is a no-op
 * when Langfuse is unconfigured or there's no active trace — see
 * lib/observability/langfuse.ts). `context.node` names the generation after
 * the pipeline node making the call so it's identifiable in a trace without
 * callers having to pass anything else through.
 */
const client = new OpenAI({
  apiKey: env.NIA_GATEWAY_API_KEY,
  baseURL: env.NIA_GATEWAY_BASE_URL,
});

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/**
 * Names the Langfuse generation this call records — the calling node's
 * name. `model` is an optional per-call-site override (e.g.
 * env.QUERYGEN_MODEL) — omit it to use env.NIA_GATEWAY_MODEL, the same
 * single-model behavior this had before per-call-site overrides existed.
 */
export type LlmCallContext = { node: string; model?: string; reasoning?: { enabled: false } };

/** Non-streaming call — used for query generation and the faithfulness check. */
export async function complete(messages: ChatMessage[], context?: LlmCallContext): Promise<string> {
  const model = context?.model ?? env.NIA_GATEWAY_MODEL;
  const startTime = new Date();
  const res = await client.chat.completions.create({
    model,
    messages,
    stream: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- gateway-only passthrough field, not in the OpenAI SDK's type
    ...(context?.reasoning ? ({ reasoning: context.reasoning } as any) : {}),
  });
  const output = res.choices[0]?.message?.content ?? "";
  recordGeneration({
    name: context?.node ?? "complete",
    model,
    input: messages,
    output,
    usage: res.usage
      ? { input: res.usage.prompt_tokens, output: res.usage.completion_tokens, total: res.usage.total_tokens }
      : undefined,
    startTime,
    endTime: new Date(),
  });
  return output;
}

/**
 * Streaming call — used for answer generation. Invokes `onToken` for each
 * text delta as it arrives and returns the full accumulated text once the
 * stream ends, so callers that need the whole answer (e.g. the faithfulness
 * check) don't have to re-assemble it themselves. `stream_options.include_usage`
 * asks the gateway to emit a final usage-only chunk so streamed generations
 * still get token counts in Langfuse (falls back to undefined usage if the
 * gateway doesn't support the option).
 */
export async function streamComplete(
  messages: ChatMessage[],
  onToken: (text: string) => void | Promise<void>,
  context?: LlmCallContext,
): Promise<string> {
  const model = context?.model ?? env.NIA_GATEWAY_MODEL;
  const startTime = new Date();
  const stream = await client.chat.completions.create({
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  });
  let full = "";
  let usage: { input?: number; output?: number; total?: number } | undefined;
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      full += delta;
      await onToken(delta);
    }
    if (chunk.usage) {
      usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens, total: chunk.usage.total_tokens };
    }
  }
  recordGeneration({
    name: context?.node ?? "streamComplete",
    model,
    input: messages,
    output: full,
    usage,
    startTime,
    endTime: new Date(),
  });
  return full;
}
