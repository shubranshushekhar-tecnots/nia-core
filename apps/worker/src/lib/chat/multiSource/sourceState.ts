import { Annotation } from "@langchain/langgraph";
import type { IntrospectResponse, QueryPayload, TabularResult } from "@nia/schemas";
import type { ResolvedConnection } from "../../resolveConnection.js";
import type { WorkspaceScope } from "@nia/db";
import type { ReductionPlan } from "../../llm/prompts/reductionPlan.js";

/**
 * Per-source pipeline state — one instance per fanned-out connectionId,
 * invoked independently by nodes/fanOutSources.ts. Deliberately mirrors the
 * field names/types of ChatState's per-query fields (../state.ts) because it
 * must structurally satisfy ResolveConnectionState / GetSchemaState /
 * GenerateQueryState / DispatchState (../nodes/shared.ts) so those 4
 * single-source nodes run against it completely unchanged — see
 * sourceGraph.ts.
 */
export const SourceState = Annotation.Root({
  /** BullMQ job id — with scope, the channel key (see publish.ts's channelFor) publishChatEvent writes to. */
  jobId: Annotation<string>(),
  conversationId: Annotation<string>(),
  connectionId: Annotation<string>(),
  scope: Annotation<WorkspaceScope>(),
  userId: Annotation<string>(),
  standaloneMessage: Annotation<string>(),
  /** The plan's reduction shape, forwarded into query generation so it can avoid arbitrary tie-breaking (see queryGen.*.ts's reductionHint). */
  reductionPlan: Annotation<ReductionPlan | undefined>({ default: () => undefined, reducer: (_, b) => b }),

  connection: Annotation<ResolvedConnection | undefined>({ default: () => undefined, reducer: (_, b) => b }),
  schema: Annotation<IntrospectResponse | undefined>({ default: () => undefined, reducer: (_, b) => b }),
  queryPayload: Annotation<QueryPayload | undefined>({ default: () => undefined, reducer: (_, b) => b }),
  queryGenAttempts: Annotation<number>({ default: () => 0, reducer: (_, b) => b }),
  guardrailRejectionReason: Annotation<string | undefined>({ default: () => undefined, reducer: (_, b) => b }),
  reintrospectedAfterFailure: Annotation<boolean>({ default: () => false, reducer: (_, b) => b }),
  lastDispatchOutcome: Annotation<"ok" | "guardrail-rejected" | "retryable" | "terminal" | undefined>({
    default: () => undefined,
    reducer: (_, b) => b,
  }),
  tabularResult: Annotation<TabularResult | undefined>({ default: () => undefined, reducer: (_, b) => b }),
  error: Annotation<string | undefined>({ default: () => undefined, reducer: (_, b) => b }),
});

export type SourceStateType = typeof SourceState.State;
