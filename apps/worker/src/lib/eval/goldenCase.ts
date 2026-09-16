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
  }),
});
export type GoldenCase = z.infer<typeof GoldenCase>;
