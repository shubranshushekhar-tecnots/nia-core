// Structured-query guardrail for agent-backed sources (route1-design.md
// §2), e.g. "sqlserver-agent" — the payload carries no SQL text, only a
// table/column/filter/cursor/limit description, so this validator's job
// is purely structural: identifier safety, operator allowlist, and the
// shared row-cap convention (packages/extract/src/filterBuilder.ts and
// guardrails/src/sql/validator.ts both use the same shape/limits; this
// file doesn't import either — @nia/schemas has no @nia/extract
// dependency, and this validator's rules are simple enough not to be
// worth one).

import type { ConnectionScope, GuardrailResult, GuardrailValidator } from "./types.js";
import type { StructuredFilterCondition } from "@nia/schemas";

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_ROWS = 1000;
const MAX_IN_VALUES = 1000;

const STRUCTURED_FILTER_OPERATORS = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "between",
  "startsWith",
  "isNull",
  "isNotNull",
]);

/** Non-empty, reasonably short, no control characters — table/column/cursor identifiers are never parsed, only matched against a connector-reported catalog downstream. */
function isSafeIdentifier(value: string): boolean {
  if (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function validateCondition(cond: StructuredFilterCondition): string | null {
  if (!isSafeIdentifier(cond.column)) {
    return `Invalid filter column identifier: ${JSON.stringify(cond.column)}`;
  }
  if (!STRUCTURED_FILTER_OPERATORS.has(cond.operator)) {
    return `Unknown filter operator: ${JSON.stringify(cond.operator)}`;
  }
  if (cond.operator === "in") {
    if (cond.values.length === 0) {
      return `"in" filter on ${JSON.stringify(cond.column)} must have at least one value`;
    }
    if (cond.values.length > MAX_IN_VALUES) {
      return `"in" filter on ${JSON.stringify(cond.column)} exceeds the ${MAX_IN_VALUES}-value limit`;
    }
  }
  return null;
}

export const validateStructuredQuery: GuardrailValidator = (
  query,
  _scope: ConnectionScope,
): GuardrailResult => {
  if (query.kind !== "structured") {
    return { ok: false, reason: `Expected a structured query payload, got kind: ${query.kind}` };
  }

  if (!isSafeIdentifier(query.table)) {
    return { ok: false, reason: `Invalid table identifier: ${JSON.stringify(query.table)}` };
  }

  for (const column of query.columns) {
    if (!isSafeIdentifier(column)) {
      return { ok: false, reason: `Invalid column identifier: ${JSON.stringify(column)}` };
    }
  }

  for (const cond of query.filter) {
    const error = validateCondition(cond);
    if (error) return { ok: false, reason: error };
  }

  if (query.cursor && !isSafeIdentifier(query.cursor.column)) {
    return { ok: false, reason: `Invalid cursor column identifier: ${JSON.stringify(query.cursor.column)}` };
  }

  // Rejected outright rather than clamped: the task's own "refused" test
  // expects a limit above the cap to fail validation, not be silently
  // reduced to it.
  if (query.limit > MAX_ROWS) {
    return { ok: false, reason: `Row limit ${query.limit} exceeds the ${MAX_ROWS}-row cap` };
  }

  return { ok: true, sanitizedQuery: query };
};
