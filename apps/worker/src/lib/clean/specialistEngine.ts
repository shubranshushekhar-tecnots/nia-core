import { z } from "zod";
import { ComputedFieldStep, ExprSchema, type ColumnStats, type OnFailurePolicy } from "@nia/schemas";
import { completeJson, JsonExtractionError } from "../llm/parseHelpers.js";
import type { ChatMessage } from "../llm/gatewayClient.js";
import type { ColumnProposal, SpecialistName, SpecialistResult } from "./specialistTypes.js";

/**
 * Phase 13, Step 4 — the one shared engine both cleaning specialists
 * (missingValueSpecialist.ts, coercionSpecialist.ts) run through. Kept in
 * one module, same reasoning as router.ts: one place owns "validate
 * against the op schema, retry once with the error, drop and report on a
 * second failure" so that contract can't drift between the two
 * specialists.
 *
 * Input to the LLM is strictly the column profile (ColumnStats — stats
 * plus the already-capped failingExamples) — never raw rows. The prompt
 * also states the closed op vocabulary explicitly (ExprSchema's own fn
 * enum rejects anything else at validation time regardless); that closed
 * vocabulary, not prompt wording, is what actually defends against a
 * malicious column name/example value trying to inject instructions —
 * the model's JSON output can only ever become a step if it round-trips
 * through ComputedFieldStep.safeParse.
 */

/** Raw shape asked of the model — one entry per requested column, either a proposed step or an explicit no-change. onFailure is deliberately NOT part of this contract: it's assigned by the specialist (not the model) per the plan's fixed per-specialist default. */
const RawColumnOutput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("step"),
    column: z.string(),
    expression: ExprSchema,
    rationale: z.string().min(1),
  }),
  z.object({
    action: z.literal("no-change"),
    column: z.string(),
    reason: z.string().min(1),
  }),
]);
type RawColumnOutput = z.infer<typeof RawColumnOutput>;

const RawSpecialistOutput = z.object({ columns: z.array(RawColumnOutput) });

export interface SpecialistEngineConfig {
  specialist: SpecialistName;
  /** Fixed per-specialist onFailure applied to every proposed step — "null" for missing-value, "quarantine" for coercion (both set by the plan, never left to the model). */
  onFailure: OnFailurePolicy;
  llmNode: string;
  /** columns already filtered to this specialist's routed set (Step 3's output), in the order they should be prompted. */
  columns: ColumnStats[];
  /** `retryContext` is only present on the one retry call, carrying the columns that failed last time plus their validation errors. */
  buildPrompt: (columns: ColumnStats[], retryContext?: { column: string; error: string }[]) => ChatMessage[];
}

/** Builds and validates the candidate step for one "step"-action column entry. Returns the validated step, or an error string on failure — this validation (ComputedFieldStep.safeParse, which recursively validates the Expr tree's fn names/arity via ExprSchema's superRefine) is this module's "compile check": an unknown function name or a bad arity fails here, before any step is ever proposed. */
function validateStepOutput(entry: Extract<RawColumnOutput, { action: "step" }>, onFailure: OnFailurePolicy): { ok: true; step: Omit<ComputedFieldStep, "id" | "provenance"> } | { ok: false; error: string } {
  const candidate = {
    kind: "computed_field" as const,
    name: entry.column,
    expression: entry.expression,
    onFailure,
  };
  const parsed = ComputedFieldStep.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message };
  }
  return { ok: true, step: { kind: "computed_field", name: parsed.data.name, expression: parsed.data.expression, onFailure: parsed.data.onFailure } };
}

async function callAndParse(messages: ChatMessage[], llmNode: string): Promise<{ ok: true; value: RawColumnOutput[] } | { ok: false; error: string }> {
  try {
    const raw = await completeJson(messages, { node: llmNode, temperature: 0 });
    const parsed = RawSpecialistOutput.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.message };
    }
    return { ok: true, value: parsed.data.columns };
  } catch (err) {
    if (err instanceof JsonExtractionError) return { ok: false, error: err.message };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Renders one column's profile as clearly delimited data for the prompt —
 * stats plus the already-capped failingExamples, nothing else. Used by
 * both specialists' buildPrompt so the "profile-only, never raw rows"
 * input contract is enforced by what's available to format, not by
 * convention at each call site.
 */
export function formatColumnProfile(stats: ColumnStats): string {
  const lines = [
    `column: ${JSON.stringify(stats.name)}`,
    `declaredType: ${JSON.stringify(stats.declaredType)}`,
    `sampleCount: ${stats.sampleCount}, nullCount: ${stats.nullCount}, emptyStringCount: ${stats.emptyStringCount}, whitespaceOnlyCount: ${stats.whitespaceOnlyCount}, missingTokenCount: ${stats.missingTokenCount}, distinctCount: ${stats.distinctCount}`,
  ];
  if (stats.parseRates) {
    for (const [key, rate] of Object.entries(stats.parseRates)) {
      if (!rate || rate.attempted === 0) continue;
      lines.push(`  parseRate.${key}: attempted=${rate.attempted} passed=${rate.passed} failingExamples=${JSON.stringify(rate.failingExamples)}`);
    }
  }
  return lines.join("\n");
}

export async function runSpecialist(config: SpecialistEngineConfig): Promise<SpecialistResult> {
  const { specialist, onFailure, llmNode, columns, buildPrompt } = config;
  if (columns.length === 0) {
    return { specialist, onFailure, proposals: [] };
  }

  const requested = new Map(columns.map((c) => [c.name, c]));
  const proposals = new Map<string, ColumnProposal>();
  const errorsByColumn = new Map<string, string>();

  const firstPass = await callAndParse(buildPrompt(columns), llmNode);
  if (!firstPass.ok) {
    // The whole call failed to produce a parseable shape — every requested column needs a retry.
    for (const name of requested.keys()) errorsByColumn.set(name, firstPass.error);
  } else {
    const byColumn = new Map(firstPass.value.map((e) => [e.column, e]));
    for (const name of requested.keys()) {
      const entry = byColumn.get(name);
      if (!entry) {
        errorsByColumn.set(name, "model returned no output for this column");
        continue;
      }
      if (entry.action === "no-change") {
        proposals.set(name, { column: name, kind: "no-change", reason: entry.reason });
        continue;
      }
      const validated = validateStepOutput(entry, onFailure);
      if (validated.ok) {
        proposals.set(name, { column: name, kind: "step", step: validated.step, rationale: entry.rationale });
      } else {
        errorsByColumn.set(name, validated.error);
      }
    }
  }

  // One retry, batched, covering only the columns that failed validation.
  if (errorsByColumn.size > 0) {
    const retryColumns = [...errorsByColumn.keys()].map((name) => requested.get(name)!);
    const retryContext = [...errorsByColumn.entries()].map(([column, error]) => ({ column, error }));
    const retryPass = await callAndParse(buildPrompt(retryColumns, retryContext), llmNode);

    if (!retryPass.ok) {
      for (const name of errorsByColumn.keys()) {
        proposals.set(name, { column: name, kind: "dropped", reason: `retry also failed: ${retryPass.error}` });
      }
    } else {
      const byColumn = new Map(retryPass.value.map((e) => [e.column, e]));
      for (const name of errorsByColumn.keys()) {
        const entry = byColumn.get(name);
        if (!entry) {
          proposals.set(name, { column: name, kind: "dropped", reason: `retry also failed: ${errorsByColumn.get(name)}` });
          continue;
        }
        if (entry.action === "no-change") {
          proposals.set(name, { column: name, kind: "no-change", reason: entry.reason });
          continue;
        }
        const validated = validateStepOutput(entry, onFailure);
        if (validated.ok) {
          proposals.set(name, { column: name, kind: "step", step: validated.step, rationale: entry.rationale });
        } else {
          proposals.set(name, { column: name, kind: "dropped", reason: `retry also failed: ${validated.error}` });
        }
      }
    }
  }

  return { specialist, onFailure, proposals: columns.map((c) => proposals.get(c.name)!) };
}
