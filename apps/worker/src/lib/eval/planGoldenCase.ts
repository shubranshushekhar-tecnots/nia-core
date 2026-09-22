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
/**
 * "capacity-safety" (Phase 13 gate follow-up, docs/decisions.md's
 * safety-property-scoring entry): scores a SAFETY PROPERTY — "no plan that
 * would breach the residual aggregate group cap ever reaches an applyable
 * `ok` status" — rather than one exact outcome path. Passes on EITHER
 * status=refused with kind=capacity-limit OR status=clarify (the model
 * asking rather than guessing past the cap is an acceptable way to satisfy
 * the property); fails on status=ok (an over-cap plan reached apply) and
 * on any other status (doesn't exercise the property at all, so can't be
 * scored as satisfying it). Deliberately its own `expect.type`, not folded
 * into "refused" via some optional accept-alternate-status flag — this
 * models a genuinely different assertion shape than every other case
 * here, and per docs/decisions.md's entry this scoring is reserved for
 * cases that test a safety property, not applied generally.
 */
export const PlanGoldenCase = z.object({
  id: z.string(),
  message: z.string(),
  expect: z.object({
    type: z.enum(["plan", "clarify", "refused", "no-connection", "capacity-safety"]),
    /** "plan"-type cases only. */
    minNodes: z.number().optional(),
    refusalKind: z.enum(["unsupported-operation", "partial-failure", "capacity-limit"]).optional(),
  }),
});
export type PlanGoldenCase = z.infer<typeof PlanGoldenCase>;
