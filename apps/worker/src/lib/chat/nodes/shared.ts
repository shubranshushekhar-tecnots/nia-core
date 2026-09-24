import type { IntrospectResponse, QueryPayload, TabularResult } from "@nia/schemas";
import type { ResolvedConnection } from "../../resolveConnection.js";
import type { WorkspaceScope } from "@nia/db";
import type { ReductionPlan } from "../../llm/prompts/reductionPlan.js";
import { publishChatEvent } from "../publish.js";

/**
 * Structural interfaces the 4 shared single-source nodes (resolveConnectionNode,
 * getSchemaNode, generateQueryNode, dispatchNode) are typed against, widened
 * from ChatStateType so the SAME functions run unchanged inside the
 * per-source multi-source subgraph (multiSource/sourceState.ts) — one
 * copy, not a duplicate that would silently drift (see Phase 3 plan).
 *
 * This works with zero runtime cost or casts: TypeScript allows a value of
 * a richer type (ChatStateType, or the per-source SourceState) to be passed
 * where a structurally-narrower interface is expected, and allows a node's
 * returned object (typed against that same narrower interface) to satisfy
 * `Partial<ChatStateType>` / `Partial<SourceState>` at the call site,
 * because excess-property checks only apply to fresh object literals, not
 * to already-typed values crossing a wider-to-Partial boundary.
 */

export interface ResolveConnectionState {
  jobId: string;
  conversationId: string;
  connectionId: string;
  scope: WorkspaceScope;
  connection?: ResolvedConnection;
  error?: string;
}

export interface GetSchemaState {
  jobId: string;
  conversationId: string;
  scope: WorkspaceScope;
  connection?: ResolvedConnection;
  schema?: IntrospectResponse;
  error?: string;
}

export interface GenerateQueryState {
  jobId: string;
  conversationId: string;
  scope: WorkspaceScope;
  connection?: ResolvedConnection;
  schema?: IntrospectResponse;
  standaloneMessage: string;
  guardrailRejectionReason?: string;
  /** Set only in the multi-source pipeline — absent (undefined) leaves single-source query-gen byte-for-byte unchanged. */
  reductionPlan?: ReductionPlan;
  queryPayload?: QueryPayload;
  error?: string;
}

/** Shared by all 3 graph builders (../graph.ts, ../multiSource/graph.ts, ../multiSource/sourceGraph.ts) — every state shape here carries `error?: string`. */
export function hasError(state: { error?: string }): boolean {
  return state.error !== undefined;
}

export interface DispatchState {
  jobId: string;
  conversationId: string;
  connectionId: string;
  connection?: ResolvedConnection;
  queryPayload?: QueryPayload;
  scope: WorkspaceScope;
  userId: string;
  queryGenAttempts: number;
  reintrospectedAfterFailure: boolean;
  tabularResult?: TabularResult;
  lastDispatchOutcome?: "ok" | "guardrail-rejected" | "retryable" | "terminal";
  guardrailRejectionReason?: string;
  error?: string;
}

export interface FailState {
  jobId: string;
  scope: WorkspaceScope;
  error?: string;
}

/**
 * Factory (not a bare node function) because the two pipelines want
 * different fallback wording when `error` itself is unset — the graphs
 * (../graph.ts, ../multiSource/graph.ts) each call this once, at module
 * load, to build their own `fail` node.
 */
export function buildFailNode(fallbackMessage: string) {
  return async function failNode(state: FailState): Promise<Partial<FailState>> {
    await publishChatEvent(state.scope, state.jobId, { type: "error", message: state.error ?? fallbackMessage });
    return {};
  };
}
