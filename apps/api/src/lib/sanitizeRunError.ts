/**
 * Small fix (2026-09-29): GET /console/orgs/:orgId/runs (routes/console.ts)
 * only, NOT the customer-facing explain_last_error copilot tool
 * (copilot/tools/explainLastError.ts) — both read the same
 * `workflow_runs.error` column via the same underlying data, but a
 * destination-write failure's raw driver/Postgres error text can embed the
 * actual customer row value for a constraint violation, e.g.:
 *   `duplicate key value violates unique constraint "x"\nDETAIL: Key (email)=(user@example.com) already exists.`
 * Staff (Console) never need that value to help a customer — only the
 * customer's own copilot tool should see it, since it's their own data.
 * This strips any "DETAIL: ..." line and any inline "Key (col)=(val) ..."
 * fragment (the general Postgres shape for unique/foreign-key/exclusion
 * violations, DETAIL-prefixed or not), replacing the whole run's error
 * with a coarse code + the remaining sanitized text.
 */

const DETAIL_LINE = /\bDETAIL:.*$/gim;
const KEY_VALUE_FRAGMENT = /Key \([^)]*\)=\([^)]*\)[^.\n]*\.?/gi;

export type SanitizedRunError = { code: string; message: string } | null;

export function sanitizeRunError(error: { message: string } | null): SanitizedRunError {
  if (!error) return null;

  const code = /duplicate key value violates unique constraint/i.test(error.message) ? "DUPLICATE_KEY" : "RUN_FAILED";

  const message = error.message
    .replace(DETAIL_LINE, "")
    .replace(KEY_VALUE_FRAGMENT, "")
    .replace(/\s+/g, " ")
    .trim();

  return { code, message: message || "The run failed. Contact support for details." };
}
