import OpenAI from "openai";
import type { WorkspaceScope } from "@nia/db";
import { recordLlmUsage } from "@nia/db";
import { env } from "../../env.js";
import { recordGeneration } from "../observability/langfuse.js";
import { dbPool } from "../dbPool.js";

/**
 * Thin wrapper around the official `openai` SDK pointed at the Nia Gateway
 * (an OpenAI-compatible AI gateway — see .nia/assets/API_REFERENCE.md).
 * This is the chat pipeline's only LLM client; nothing else in the repo
 * calls out to a model. Server-side only — apps/web never imports this.
 *
 * Every call records one Langfuse generation (recordGeneration is a no-op
 * when Langfuse is unconfigured or there's no active trace — see
 * lib/observability/langfuse.ts) AND one llm_usage row (Console v2 token
 * usage ledger, packages/db/src/llmUsage.ts) — the latter never throws, so
 * a recording failure can never break the underlying LLM call.
 */
const client = new OpenAI({
  apiKey: env.NIA_GATEWAY_API_KEY,
  baseURL: env.NIA_GATEWAY_BASE_URL,
});

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/**
 * `node` names the Langfuse generation this call records — the calling
 * node's name (unchanged behaviour). `feature` and `scope` are required —
 * the llm_usage ledger needs them on every call, so a new call site that
 * forgets either fails typecheck rather than silently writing an
 * unattributed row. `workflowId`/`jobId`/`userId` are optional: populated
 * only where the calling pipeline genuinely has them (chat pipelines carry
 * jobId, not workflowId; mapping/cleaning/plan pipelines carry workflowId,
 * not jobId; userId only where a single acting user triggered the call).
 * `model` is an optional per-call-site override (e.g. env.QUERYGEN_MODEL) —
 * omit it to use env.NIA_GATEWAY_MODEL. `temperature` is an optional
 * per-call-site override, omitted by default (gateway/model default
 * applies) — set explicitly by call sites that need deterministic output
 * (e.g. generatePlanNode, Phase 13 gate: sampling variance was the source
 * of eval:golden:plan flakiness, not model drift — see docs/decisions.md's
 * Phase 13 gate entry).
 */
export type LlmCallContext = {
  node: string;
  feature: string;
  scope: WorkspaceScope;
  workflowId?: string;
  jobId?: string;
  userId?: string;
  model?: string;
  temperature?: number;
  reasoning?: { enabled: false };
};

function errorCodeOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

/** Non-streaming call — used for query generation and the faithfulness check. */
export async function complete(messages: ChatMessage[], context: LlmCallContext): Promise<string> {
  const model = context.model ?? env.NIA_GATEWAY_MODEL;
  const startTime = new Date();
  let res;
  try {
    res = await client.chat.completions.create({
      model,
      messages,
      stream: false,
      ...(context.temperature !== undefined ? { temperature: context.temperature } : {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- gateway-only passthrough field, not in the OpenAI SDK's type
      ...(context.reasoning ? ({ reasoning: context.reasoning } as any) : {}),
    });
  } catch (err) {
    await recordLlmUsage(dbPool, {
      scope: context.scope,
      userId: context.userId,
      workflowId: context.workflowId,
      runId: context.jobId,
      feature: context.feature,
      model,
      latencyMs: Date.now() - startTime.getTime(),
      status: "error",
      errorCode: errorCodeOf(err),
    });
    throw err;
  }
  const output = res.choices[0]?.message?.content ?? "";
  const endTime = new Date();
  recordGeneration({
    name: context.node,
    model,
    input: messages,
    output,
    usage: res.usage
      ? { input: res.usage.prompt_tokens, output: res.usage.completion_tokens, total: res.usage.total_tokens }
      : undefined,
    startTime,
    endTime,
  });
  await recordLlmUsage(dbPool, {
    scope: context.scope,
    userId: context.userId,
    workflowId: context.workflowId,
    runId: context.jobId,
    feature: context.feature,
    model,
    latencyMs: endTime.getTime() - startTime.getTime(),
    status: "ok",
    usage: res.usage
      ? { inputTokens: res.usage.prompt_tokens, outputTokens: res.usage.completion_tokens, totalTokens: res.usage.total_tokens }
      : undefined,
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
 * gateway doesn't support the option) and in llm_usage. A stream cut off
 * before that final chunk arrives (e.g. a dropped connection) is recorded
 * with status="aborted" and usage_known=false rather than trusting a
 * partial count.
 */
export async function streamComplete(
  messages: ChatMessage[],
  onToken: (text: string) => void | Promise<void>,
  context: LlmCallContext,
): Promise<string> {
  const model = context.model ?? env.NIA_GATEWAY_MODEL;
  const startTime = new Date();
  let full = "";
  let usage: { input?: number; output?: number; total?: number } | undefined;
  let aborted = false;
  let thrown: unknown;
  try {
    const stream = await client.chat.completions.create({
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    });
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
  } catch (err) {
    aborted = true;
    thrown = err;
  }
  const endTime = new Date();
  recordGeneration({
    name: context.node,
    model,
    input: messages,
    output: full,
    usage,
    startTime,
    endTime,
  });
  await recordLlmUsage(dbPool, {
    scope: context.scope,
    userId: context.userId,
    workflowId: context.workflowId,
    runId: context.jobId,
    feature: context.feature,
    model,
    latencyMs: endTime.getTime() - startTime.getTime(),
    status: aborted ? "aborted" : "ok",
    usage: usage && !aborted ? { inputTokens: usage.input, outputTokens: usage.output, totalTokens: usage.total } : undefined,
    errorCode: aborted ? errorCodeOf(thrown) : undefined,
  });
  if (thrown) throw thrown;
  return full;
}
