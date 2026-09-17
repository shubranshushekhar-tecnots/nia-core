import { z } from "zod";

/**
 * One line of fixtures/golden/chat-v1.jsonl. `connectors` names seeded
 * sandbox connections (see sandbox.ts) plus the literal "invalid" sentinel
 * (an intentionally nonexistent connectionId, for partial-failure cases) —
 * resolved to real UUIDs by runGoldenSuite.ts at run time, never hardcoded
 * in the fixture itself, so the fixture survives sandbox reseeding.
 */
export const GoldenCase = z.object({
  id: z.string(),
  connectors: z.array(z.enum(["mysql", "mongodb", "supabase", "invalid"])),
  message: z.string(),
  expect: z.object({
    type: z.enum(["answer", "refused", "conflict", "no-connection"]),
    mustContain: z.array(z.string()).optional(),
    mustNotContain: z.array(z.string()).optional(),
    refusalKind: z.enum(["unsupported-operation", "partial-failure", "capacity-limit"]).optional(),
    /**
     * "answer"-type cases only. Defaults to "ok" (must ship faithful on the
     * first try, today's only behavior). "conflict-final" asserts the
     * pipeline's faithfulness retry loop actually fired once and the
     * answer still shipped unfaithful after that retry — for a golden case
     * specifically engineered to exercise that path. When set,
     * runGoldenSuite.ts does NOT auto-fail on faithful:false; it instead
     * asserts faithfulnessOutcome === "conflict-final" and
     * answerGenAttempts === 1. As of Phase 5 Session 5 no fixture case sets
     * this — see docs/decisions.md's "Block 4" write-up for the live
     * investigation into why an organic trigger proved unreachable with the
     * current pipeline + model, and what infrastructure (this field
     * included) is left in place for if/when one is found.
     */
    expectFaithfulnessOutcome: z.enum(["ok", "conflict-final"]).optional(),
  }),
});
export type GoldenCase = z.infer<typeof GoldenCase>;
