import { env } from "../../env.js";
import { complete } from "./gatewayClient.js";
import type { ChatMessage, LlmCallContext } from "./gatewayClient.js";
import { recordEvent } from "../observability/langfuse.js";

/** Strips markdown code fences some models wrap JSON in, despite instructions not to. */
export function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced ? fenced[1]!.trim() : trimmed;
}

/** Thrown by extractJson when no parseable JSON could be found in the raw text at all (as opposed to a salvage that succeeded). */
export class JsonExtractionError extends Error {}

/**
 * Scans `text` for the first top-level balanced `{...}` or `[...]` block
 * and returns that slice, or undefined if none closes (e.g. truncated
 * output). Respects string contents (including escaped quotes) so braces
 * inside string values don't throw off the depth count.
 */
function extractBalancedJsonBlock(text: string): string | undefined {
  const start = text.search(/[{[]/);
  if (start === -1) return undefined;
  const openChar = text[start];
  const closeChar = openChar === "{" ? "}" : "]";

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === openChar) {
      depth++;
    } else if (ch === closeChar) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/**
 * Tolerant JSON extraction from raw LLM output. Every prompt in this
 * pipeline asks for JSON-only output, but models occasionally wrap it in
 * markdown fences or stray prose ("let me reconsider the query...") despite
 * that instruction — observed live in query-gen smoke runs. Rather than
 * treat that as an unrecoverable parse failure (which previously surfaced
 * as flaky, model-whim-dependent node failures), this tries, in order:
 *   1. strip code fences, parse directly
 *   2. scan for the first balanced top-level `{...}`/`[...]` block in the
 *      (fence-stripped) text and parse THAT slice, tolerating prose before
 *      and/or after it
 * Step 2 succeeding is recorded as a structured `llm_json_salvage` event
 * (not silently swallowed) so how often models do this is visible — see
 * lib/observability/langfuse.ts's recordEvent, which falls back to the
 * same structured console.warn when Langfuse is unconfigured or there's no
 * active trace in scope.
 * Throws JsonExtractionError if neither step produces valid JSON (e.g.
 * truncated output) — callers decide what a total failure means for them.
 */
export function extractJson(raw: string, context: LlmCallContext): unknown {
  const stripped = stripFences(raw);
  try {
    return JSON.parse(stripped);
  } catch {
    // fall through to salvage
  }

  const salvaged = extractBalancedJsonBlock(stripped);
  if (salvaged !== undefined) {
    try {
      const parsed = JSON.parse(salvaged);
      recordEvent("llm_json_salvage", {
        node: context.node,
        model: context.model ?? env.NIA_GATEWAY_MODEL,
        rawPreview: raw.slice(0, 300),
      });
      return parsed;
    } catch {
      // fall through to throw
    }
  }

  throw new JsonExtractionError(`Could not extract JSON from model output: ${raw.slice(0, 300)}`);
}

/**
 * complete() + extractJson(), with ONE retry if extraction totally fails
 * on the first attempt — a terse system-message addendum telling the model
 * to respond with ONLY JSON, then one more try. Mirrors the retry-once-
 * then-ship shape ../prompts/faithfulness.ts's applyFaithfulnessVerdict
 * uses for faithfulness conflicts: fail loudly after one retry rather than
 * looping or silently accepting garbage. If the retry also fails to
 * extract, the JsonExtractionError from that second attempt propagates —
 * callers already have to handle extractJson's failure mode, so this adds
 * no new error shape for them to handle.
 */
export async function completeJson(messages: ChatMessage[], context: LlmCallContext): Promise<unknown> {
  const raw = await complete(messages, context);
  try {
    return extractJson(raw, context);
  } catch (err) {
    if (!(err instanceof JsonExtractionError)) throw err;
  }

  const retryMessages: ChatMessage[] = [...messages, { role: "system", content: "Respond with ONLY the JSON object. No prose." }];
  const retryRaw = await complete(retryMessages, context);
  return extractJson(retryRaw, context);
}
