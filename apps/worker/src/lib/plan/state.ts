import { Annotation } from "@langchain/langgraph";
import type { GraphDoc, Plan } from "@nia/schemas";
import type { WorkspaceScope } from "../workspaceScope.js";
import type { VisibleConnection } from "./listConnections.js";

/**
 * Phase 7 Session 1 — plan-propose pipeline state. Same
 * default+reducer:(_, b) => b requirement every optional ChatState field
 * has (see chat/state.ts's header comment — the installed
 * @langchain/langgraph version's SingleReducer typing requires it whenever
 * a channel config object is passed).
 *
 * `planGenAttempts` caps the structure/feasibility retry loop at exactly
 * one retry (see nodes/shared.ts's decideRetryOrRefuse) — same
 * cap-1-attempt shape as chat's queryGenAttempts.
 */
export const PlanState = Annotation.Root({
  jobId: Annotation<string>(),
  userId: Annotation<string>(),
  workflowId: Annotation<string>(),
  conversationId: Annotation<string>(),
  scope: Annotation<WorkspaceScope>(),
  rawMessage: Annotation<string>(),

  existingGraph: Annotation<GraphDoc | undefined>({ default: () => undefined, reducer: (_, b) => b }),
  /** WorkspaceScope-filtered connection list (listConnections.ts) — both the LLM's candidate context and checkConnections' closed-world check draw from this same fetch. */
  connections: Annotation<VisibleConnection[]>({ default: () => [], reducer: (_, b) => b }),

  plan: Annotation<Plan | undefined>({ default: () => undefined, reducer: (_, b) => b }),
  clarifyQuestion: Annotation<string | undefined>({ default: () => undefined, reducer: (_, b) => b }),
  /** Incremented once per generatePlan call (including the very first) — see decideRetryOrRefuse. */
  planGenAttempts: Annotation<number>({ default: () => 0, reducer: (_, b) => b }),
  /** Failure text fed back into the next generatePlan prompt as correction context — cleared once consumed. */
  feedback: Annotation<string | undefined>({ default: () => undefined, reducer: (_, b) => b }),

  /** Set by checkConnections when a plan node references a connectionId outside `connections` — distinct from a checks.ts-style refusal so the golden suite/caller can tell "invisible connection" apart from "well-formed-but-infeasible plan" (mirrors chat's own separate no-connection-selected outcome). */
  noConnection: Annotation<boolean>({ default: () => false, reducer: (_, b) => b }),
  /** Set by validateStructure/validateFeasibility so the graph's conditional edges can route without re-deriving the outcome. */
  lastValidationOutcome: Annotation<"ok" | "retry" | "refused" | undefined>({ default: () => undefined, reducer: (_, b) => b }),
  refusalKind: Annotation<"unsupported-operation" | "partial-failure" | "capacity-limit" | undefined>({
    default: () => undefined,
    reducer: (_, b) => b,
  }),

  error: Annotation<string | undefined>({ default: () => undefined, reducer: (_, b) => b }),
});

export type PlanStateType = typeof PlanState.State;
