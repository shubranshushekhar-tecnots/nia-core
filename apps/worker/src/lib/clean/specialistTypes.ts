import type { ComputedFieldStep, OnFailurePolicy } from "@nia/schemas";

/**
 * Phase 13, Step 4 — shared shapes for both cleaning specialists
 * (missingValueSpecialist.ts / coercionSpecialist.ts) and the engine that
 * drives both (specialistEngine.ts).
 */

export type SpecialistName = "missing-value" | "coercion";

/** A specialist proposed a computed_field step for this column. `step` has no `id`/`provenance` yet — Step 5's assemble() assigns those once the step's final position in the node's step array is known. */
export interface ColumnStepProposal {
  column: string;
  kind: "step";
  step: Omit<ComputedFieldStep, "id" | "provenance">;
  rationale: string;
}

/** A specialist looked at this column and decided nothing should change. */
export interface ColumnNoChangeProposal {
  column: string;
  kind: "no-change";
  reason: string;
}

/** The specialist's output for this column failed validation twice (initial + one retry) and was dropped. */
export interface ColumnDroppedProposal {
  column: string;
  kind: "dropped";
  reason: string;
}

export type ColumnProposal = ColumnStepProposal | ColumnNoChangeProposal | ColumnDroppedProposal;

export interface SpecialistResult {
  specialist: SpecialistName;
  /** The onFailure policy this specialist's step proposals were built with — "null" for missing-value, "quarantine" for coercion. */
  onFailure: OnFailurePolicy;
  proposals: ColumnProposal[];
}
