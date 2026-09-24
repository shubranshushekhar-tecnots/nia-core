import { Annotation } from "@langchain/langgraph";
import type { IntrospectResponse, QueryPayload, TabularResult } from "@nia/schemas";
import type { ResolvedConnection } from "../resolveConnection.js";
import type { WorkspaceScope } from "@nia/db";

/**
 * Single-source chat pipeline state. `queryGenAttempts`/`answerGenAttempts`
 * cap their respective regeneration loops at exactly one retry each (see
 * graph.ts's conditional edges) — never a general-purpose retry counter.
 *
 * Every optional/defaulted field below pairs `default` with an explicit
 * `reducer: (_, b) => b` (last-write-wins) — the installed
 * @langchain/langgraph version's `SingleReducer` type requires a reducer
 * whenever a channel config object is passed; only the bare `Annotation<T>()`
 * (no object arg) overload gets last-value-wins for free, and that overload
 * has no `default`.
 */
export const ChatState = Annotation.Root({
  /** BullMQ job id — with scope, the channel key (see publish.ts's channelFor) publishChatEvent writes to. */
  jobId: Annotation<string>(),
  userId: Annotation<string>(),
  conversationId: Annotation<string>(),
  connectionId: Annotation<string>(),
  scope: Annotation<WorkspaceScope>(),
  rawMessage: Annotation<string>(),

  standaloneMessage: Annotation<string>({ default: () => "", reducer: (_, b) => b }),
  connection: Annotation<ResolvedConnection | undefined>({ default: () => undefined, reducer: (_, b) => b }),
  schema: Annotation<IntrospectResponse | undefined>({ default: () => undefined, reducer: (_, b) => b }),
  queryPayload: Annotation<QueryPayload | undefined>({ default: () => undefined, reducer: (_, b) => b }),
  queryGenAttempts: Annotation<number>({ default: () => 0, reducer: (_, b) => b }),
  guardrailRejectionReason: Annotation<string | undefined>({ default: () => undefined, reducer: (_, b) => b }),
  reintrospectedAfterFailure: Annotation<boolean>({ default: () => false, reducer: (_, b) => b }),
  /** Set by the dispatch node so its conditional edge can route without re-deriving the error kind. */
  lastDispatchOutcome: Annotation<"ok" | "guardrail-rejected" | "retryable" | "terminal" | undefined>({
    default: () => undefined,
    reducer: (_, b) => b,
  }),

  tabularResult: Annotation<TabularResult | undefined>({ default: () => undefined, reducer: (_, b) => b }),

  answer: Annotation<string | undefined>({ default: () => undefined, reducer: (_, b) => b }),
  answerGenAttempts: Annotation<number>({ default: () => 0, reducer: (_, b) => b }),
  faithful: Annotation<boolean>({ default: () => true, reducer: (_, b) => b }),
  faithfulnessReason: Annotation<string | undefined>({ default: () => undefined, reducer: (_, b) => b }),
  /** Set by the faithfulness node so its conditional edge can route without re-deriving it from attempt counts. */
  faithfulnessOutcome: Annotation<"ok" | "conflict-retry" | "conflict-final" | undefined>({
    default: () => undefined,
    reducer: (_, b) => b,
  }),

  error: Annotation<string | undefined>({ default: () => undefined, reducer: (_, b) => b }),
});

export type ChatStateType = typeof ChatState.State;
