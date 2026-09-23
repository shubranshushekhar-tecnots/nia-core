import { describe, expect, it } from "vitest";
import { ComputedFieldStep } from "@nia/schemas";
import { SYSTEM_PROMPT as missingValuePrompt } from "./missingValueSpecialist.js";
import { SYSTEM_PROMPT as coercionPrompt } from "./coercionSpecialist.js";

/**
 * Phase 13 checkpoint follow-up (requirement 4) — regression guard for the
 * exact class of bug found in Step 4: the missing-value specialist's
 * SYSTEM_PROMPT embeds a concrete, literal JSON example
 * (`{"kind":"literal","value":null}`) illustrating its "then" branch, but
 * the Expr grammar didn't accept a null literal at the time, so that
 * example would have failed `ComputedFieldStep.safeParse` — the exact
 * "compile check" `specialistEngine.ts`'s `validateStepOutput` runs on
 * every real specialist response. This test would have caught it: it
 * scans each specialist's SYSTEM_PROMPT for every syntactically valid
 * embedded JSON object (the grammar-rule lines like
 * `{"kind":"field","name":<column>}` contain unquoted placeholders and are
 * NOT valid JSON — only genuinely concrete examples parse), and asserts
 * each one validates against the op schema as a computed_field expression.
 */

/**
 * Scans `text` for every balanced `{...}` substring starting at each `{`
 * character and returns the ones that are valid JSON — a placeholder-
 * bearing grammar line like `{"kind":"field","name":<column>}` fails
 * JSON.parse (an unquoted `<column>` isn't valid JSON) and is silently
 * skipped, while a concrete example like `{"kind":"literal","value":null}`
 * parses successfully. Deduplicates by source substring since a valid
 * outer object and its valid nested objects would otherwise both be found
 * independently (this file's examples are all bare literals, so dedup is a
 * no-op today, but keeps the scan correct if a future prompt embeds a
 * concrete nested example).
 */
function extractJsonObjects(text: string): unknown[] {
  const seen = new Set<string>();
  const results: unknown[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') {
        inString = true;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(i, j + 1);
          if (!seen.has(candidate)) {
            try {
              results.push(JSON.parse(candidate));
              seen.add(candidate);
            } catch {
              // Not valid JSON (a grammar-rule line with unquoted
              // placeholders, e.g. `<column>`/`<Expr>`) — not a concrete
              // example output, skip it.
            }
          }
          break;
        }
      }
    }
  }
  return results;
}

/** A bare extracted object is an Expr fragment (e.g. `{"kind":"literal",...}`), never a full step — wrap it as a computed_field's expression, the same shape `specialistEngine.ts`'s `validateStepOutput` builds from a real "step" response, before running the same `ComputedFieldStep.safeParse` compile check. */
function compilesAsComputedField(expression: unknown): boolean {
  const candidate = { kind: "computed_field", name: "y", expression };
  return ComputedFieldStep.safeParse(candidate).success;
}

describe("specialist prompt examples parse and compile against the op schema", () => {
  it("finds at least one concrete embedded JSON example in the missing-value specialist prompt", () => {
    expect(extractJsonObjects(missingValuePrompt).length).toBeGreaterThan(0);
  });

  it("every concrete embedded JSON example in the missing-value specialist prompt compiles as a computed_field expression", () => {
    const examples = extractJsonObjects(missingValuePrompt);
    for (const example of examples) {
      expect(compilesAsComputedField(example)).toBe(true);
    }
  });

  it("finds at least one concrete embedded JSON example in the coercion specialist prompt", () => {
    expect(extractJsonObjects(coercionPrompt).length).toBeGreaterThan(0);
  });

  it("every concrete embedded JSON example in the coercion specialist prompt compiles as a computed_field expression", () => {
    const examples = extractJsonObjects(coercionPrompt);
    for (const example of examples) {
      expect(compilesAsComputedField(example)).toBe(true);
    }
  });
});
