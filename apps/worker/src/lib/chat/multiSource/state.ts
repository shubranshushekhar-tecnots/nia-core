import { Annotation } from "@langchain/langgraph";
import type { WorkspaceScope } from "../../workspaceScope.js";
import type { ReductionPlan } from "../../llm/prompts/reductionPlan.js";
import type { ReduceOutcome } from "./reduce.js";

export interface SourceResult {
  connectionId: string;
  ok: boolean;
  tabularResult?: import("@nia/schemas").TabularResult;
  error?: string;
  timedOut?: boolean;
}

/**
 * Top-level multi-source chat pipeline state. Mirrors ChatState's shape
 * (../state.ts) for the fields it shares, but is a genuinely different
 * state — there is no single `connectionId`/`schema`/`tabularResult`; those
 * live per-source inside `sourceResults` (populated by
 * nodes/fanOutSources.ts, one entry per connectionId, via the per-source
 * subgraph in sourceGraph.ts).
 */
export const MultiSourceState = Annotation.Root({
  /** BullMQ job id — with scope, the channel key (see publish.ts's channelFor) publishChatEvent writes to. */
  jobId: Annotation<string>(),
  userId: Annotation<string>(),
  conversationId: Annotation<string>(),
  connectionIds: Annotation<string[]>(),
  scope: Annotation<WorkspaceScope>(),
  rawMessage: Annotation<string>(),

  standaloneMessage: Annotation<string>({ default: () => "", reducer: (_, b) => b }),
  reductionPlan: Annotation<ReductionPlan | undefined>({ default: () => undefined, reducer: (_, b) => b }),

  sourceResults: Annotation<SourceResult[]>({ default: () => [], reducer: (_, b) => b }),

  reduceOutcome: Annotation<ReduceOutcome | undefined>({ default: () => undefined, reducer: (_, b) => b }),

  answer: Annotation<string | undefined>({ default: () => undefined, reducer: (_, b) => b }),
  answerGenAttempts: Annotation<number>({ default: () => 0, reducer: (_, b) => b }),
  faithful: Annotation<boolean>({ default: () => true, reducer: (_, b) => b }),
  faithfulnessReason: Annotation<string | undefined>({ default: () => undefined, reducer: (_, b) => b }),
  faithfulnessOutcome: Annotation<"ok" | "conflict-retry" | "conflict-final" | undefined>({
    default: () => undefined,
    reducer: (_, b) => b,
  }),

  /** Set when the request is refused outright — routes straight to nodes/refuseNode.ts. */
  refusal: Annotation<{ kind: "unsupported-operation" | "partial-failure" | "capacity-limit"; message: string } | undefined>({
    default: () => undefined,
    reducer: (_, b) => b,
  }),
  /** Set when reduce.ts reports more than one winner for a max/min plan — surfaced as its own `conflict` stream event, never folded into faithfulnessReason. */
  conflictMessage: Annotation<string | undefined>({ default: () => undefined, reducer: (_, b) => b }),

  error: Annotation<string | undefined>({ default: () => undefined, reducer: (_, b) => b }),
});

export type MultiSourceStateType = typeof MultiSourceState.State;
