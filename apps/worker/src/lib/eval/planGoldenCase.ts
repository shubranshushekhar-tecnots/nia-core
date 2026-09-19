import { z } from "zod";

/**
 * One line of fixtures/golden/plan-v1.jsonl. Mirrors goldenCase.ts's
 * GoldenCase shape/rationale where it applies, but PlanProposeJob (unlike
 * ChatQueryJob) carries no `connectionIds` allowlist — plan-propose always
 * sees every connection visible in the workspace (listVisibleConnections,
 * closed-world-checked against whatever connectionId the model actually
 * proposes) rather than a caller-selected subset. So there is no
 * `connectors` field here: every case runs against the same seeded
 * mysql/mongodb/supabase connections, and a case that wants to exercise
 * the "connection invisible to this workspace" path does so by naming an
 * out-of-workspace connectionId directly in `message` (see plan-v1.jsonl's
 * "connection-invisible-to-user" case) — the model is free to comply with
 * an explicit id a user typed, and checkConnections.ts is exactly the
 * backstop for when it does.
 */
export const PlanGoldenCase = z.object({
  id: z.string(),
  message: z.string(),
  expect: z.object({
    type: z.enum(["plan", "clarify", "refused", "no-connection"]),
    /** "plan"-type cases only. */
    minNodes: z.number().optional(),
    refusalKind: z.enum(["unsupported-operation", "partial-failure", "capacity-limit"]).optional(),
  }),
});
export type PlanGoldenCase = z.infer<typeof PlanGoldenCase>;
