import { AsyncLocalStorage } from "node:async_hooks";
import { Langfuse } from "langfuse";
import type { LangfuseTraceClient, LangfuseSpanClient } from "langfuse";
import type { WorkspaceScope } from "@nia/db";
import { env } from "../../env.js";

/**
 * Self-hosted Langfuse tracing (see docker-compose.yml's langfuse-server).
 * Deliberately degrades to a no-op when LANGFUSE_PUBLIC_KEY/SECRET_KEY are
 * unset (env.ts leaves them optional) — the worker must run fine with zero
 * Langfuse env, per Phase 4's Task 2.
 *
 * Trace model (one call site each, not scattered):
 *  - one trace per chat job, traceId = jobId (runInTrace — called once from
 *    index.ts, wrapping each graph.invoke() call).
 *  - one span per pipeline node in BOTH graphs (withNodeSpan — wraps every
 *    .addNode() call site in graph.ts / multiSource/graph.ts /
 *    multiSource/sourceGraph.ts).
 *  - one generation per LLM call (recordGeneration — called from
 *    gatewayClient.ts's two call sites: complete()/streamComplete()).
 *
 * AsyncLocalStorage carries the "current parent" (trace, or the innermost
 * open span) across node/LLM-call boundaries so nested spans/generations
 * attach to the right parent without threading an observability param
 * through every node's signature — every node already just takes `state`
 * and returns `Partial<state>`, and preserving that shape (vs. plumbing a
 * span reference through lib/chat everywhere) is why this lives apart from
 * lib/chat entirely.
 *
 * NEVER pass credentials, vault refs, or full row data into any of these —
 * only metadata (rowCount, truncated, durationMs) and executedQuery (this
 * is already the citation/audit payload elsewhere in this codebase — see
 * TabularMeta in @nia/schemas — so surfacing it here is not new exposure).
 */

type Parent = LangfuseTraceClient | LangfuseSpanClient;

const als = new AsyncLocalStorage<Parent>();

const client: Langfuse | undefined =
  env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY
    ? new Langfuse({
        publicKey: env.LANGFUSE_PUBLIC_KEY,
        secretKey: env.LANGFUSE_SECRET_KEY,
        baseUrl: env.LANGFUSE_BASE_URL,
      })
    : undefined;

export const langfuseEnabled = client !== undefined;

/** Wraps one chat job's entire pipeline invocation in a single root trace. */
export async function runInTrace<T>(
  params: {
    jobId: string;
    scope: WorkspaceScope;
    conversationId: string;
    mode: "single" | "multi";
    /** Connection @handles, e.g. "@mysql-prod" — NEVER credentials/vault refs. */
    connectionHandles: string[];
  },
  fn: () => Promise<T>,
): Promise<T> {
  if (!client) return fn();
  const trace = client.trace({
    id: params.jobId,
    name: `chat:${params.mode}`,
    metadata: {
      ...("orgId" in params.scope ? { orgId: params.scope.orgId } : { ownerId: params.scope.ownerId }),
      conversationId: params.conversationId,
      mode: params.mode,
      connectionHandles: params.connectionHandles,
    },
  });
  return als.run(trace, fn);
}

/** Wraps one LangGraph node execution in a child span of the current trace/span. */
export function withNodeSpan<S extends object>(
  name: string,
  fn: (state: S) => Promise<Partial<S>>,
): (state: S) => Promise<Partial<S>> {
  return async (state: S) => {
    const parent = als.getStore();
    if (!parent) return fn(state);
    const span = parent.span({ name });
    try {
      const result = await als.run(span, () => fn(state));
      span.end();
      return result;
    } catch (err) {
      span.end({ level: "ERROR", statusMessage: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  };
}

/** Records one LLM call as a generation under the current trace/span. No-op outside a trace. */
export function recordGeneration(params: {
  name: string;
  model: string;
  input: unknown;
  output: string;
  usage?: { input?: number; output?: number; total?: number };
  startTime: Date;
  endTime: Date;
}): void {
  const parent = als.getStore();
  if (!parent) return;
  parent.generation({
    name: params.name,
    model: params.model,
    input: params.input,
    output: params.output,
    usage: params.usage,
    startTime: params.startTime,
    endTime: params.endTime,
  });
}

/**
 * Structured event on the active span/trace — e.g. llm_json_salvage.
 * Falls back to a one-line console.warn (same JSON shape) when Langfuse is
 * unconfigured OR there's no active trace in scope (e.g. a script invoking
 * a node function outside runInTrace) — the caller doesn't need to
 * distinguish those cases, only that the event is never silently dropped.
 */
export function recordEvent(name: string, metadata: Record<string, unknown>): void {
  const parent = als.getStore();
  if (client && parent) {
    parent.event({ name, metadata });
    return;
  }
  console.warn(JSON.stringify({ event: name, ...metadata }));
}

/**
 * Attaches a score to an already-completed trace — used by the golden-set
 * eval runner (lib/eval/runGoldenSuite.ts) to link each question's pass/
 * fail verdict to the Langfuse trace runChatQuery already created for it
 * (traceId = jobId). Unlike the other recorders here, this is NOT
 * ALS-scoped: eval scoring happens after runChatQuery's trace has already
 * closed, so it addresses the trace by id directly rather than via the
 * "current parent" mechanism.
 */
export function recordScore(params: { traceId: string; name: string; value: number; comment?: string }): void {
  client?.score(params);
}

export async function flushLangfuse(): Promise<void> {
  await client?.flushAsync();
}

export async function shutdownLangfuse(): Promise<void> {
  await client?.shutdownAsync();
}
