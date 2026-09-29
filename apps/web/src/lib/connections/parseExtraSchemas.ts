/**
 * Parses AddConnectionDialog's optional "extra schemas" text input (comma
 * and/or whitespace separated, e.g. "analytics, reporting") into the
 * string[] buildReadOnlyStatementText's extraSchemas option expects.
 * Extracted so the parsing is unit-testable without rendering the
 * component — same precedent as this directory's formFields.ts.
 */
export function parseExtraSchemas(input: string): string[] {
  return input
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
