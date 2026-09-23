import { z } from "zod";
import { MappingEntry } from "./nodeConfig.js";

/**
 * Shape an LLM-proposed mapping must parse into (Task 3, item 2) — validated
 * via the hardened extractJson/completeJson path (apps/worker's
 * lib/llm/parseHelpers.ts) against the model's raw completion, so a
 * prose-wrapped or fenced response is salvaged before ever reaching this
 * schema. Deliberately just `{ entries }` (reuses nodeConfig.ts's
 * MappingEntry as-is) — a proposal is never auto-applied, so it doesn't
 * carry `version`/`approvedAt`; those are assigned only when the user
 * explicitly approves (see FieldMapping in nodeConfig.ts).
 */
export const ProposalSchema = z.object({
  entries: z.array(MappingEntry),
});
export type ProposalSchema = z.infer<typeof ProposalSchema>;

/**
 * The mappings_propose BullMQ job's return value shape — a shared contract
 * between apps/worker (produces it, lib/mappings/proposeMapping.ts) and
 * apps/api (validates it after crossing the job.data/job.returnvalue JSON
 * round-trip, lib/mappingsQueue.ts), same reason CheckResult in checks.ts is
 * a shared zod schema rather than a plain TS type duplicated on both sides.
 * `error.kind` is intentionally a loose string here, not the worker's own
 * ProposeMappingErrorKind union — that union is worker-internal
 * implementation detail; apps/api only ever surfaces `error.message` to the
 * caller, never branches on `kind`.
 */
export const ProposeMappingOutcome = z.union([
  z.object({ ok: z.literal(true), value: ProposalSchema }),
  z.object({ ok: z.literal(false), error: z.object({ kind: z.string(), message: z.string() }) }),
]);
export type ProposeMappingOutcome = z.infer<typeof ProposeMappingOutcome>;
