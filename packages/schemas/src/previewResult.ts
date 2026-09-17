import { z } from "zod";
import { Column } from "./tabular.js";

/**
 * Destination-node read preview (Phase 5 Session 5). Read-side only: the
 * columns/rows come straight from the pushed-down query against the
 * source, already re-aliased to destination field names by the query
 * builder (runPreview.ts) so the drawer never needs a second client-side
 * rename pass. `residualCount` > 0 means the path has in-stream transforms
 * this preview did NOT execute (Phase 6 territory) — the drawer must show
 * the "N in-stream transforms will apply at run time" notice whenever this
 * is nonzero; never claim completeness it doesn't have.
 */
export const PreviewChart = z.object({
  kind: z.literal("bar"),
  labelColumn: z.string(),
  valueColumn: z.string(),
});
export type PreviewChart = z.infer<typeof PreviewChart>;

export const PreviewValue = z.object({
  columns: z.array(Column),
  rows: z.array(z.array(z.unknown())),
  truncated: z.boolean(),
  residualCount: z.number().int().nonnegative(),
  chart: PreviewChart.nullable(),
});
export type PreviewValue = z.infer<typeof PreviewValue>;

/**
 * The preview_run BullMQ job's return value shape — same shared-contract
 * reasoning as ProposeMappingOutcome (mappingProposal.ts): a zod schema so
 * apps/api can runtime-validate the worker's job.returnvalue after its
 * Redis/BullMQ JSON round-trip. `error.kind` is a loose string, not the
 * worker's own PreviewErrorKind union, for the same "worker-internal detail,
 * caller only surfaces error.message" reason.
 */
export const PreviewOutcome = z.union([
  z.object({ ok: z.literal(true), value: PreviewValue }),
  z.object({ ok: z.literal(false), error: z.object({ kind: z.string(), message: z.string() }) }),
]);
export type PreviewOutcome = z.infer<typeof PreviewOutcome>;
