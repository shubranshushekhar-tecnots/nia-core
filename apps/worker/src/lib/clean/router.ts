import type { ColumnStats } from "@nia/schemas";

/**
 * Phase 13, Step 3 — deterministic (no-LLM) routing from a Phase 10
 * ColumnStats to which cleaning specialist(s), if any, should look at a
 * column. Pure function of the profile; never touches raw rows or an LLM.
 * Every rule this module implements is kept here, in one place, so the
 * eval corpus (eval/clean/*) and the specialists (Step 4) have a single
 * source of truth to check against.
 */

export type RouteKind = "missing-value" | "coercion" | "both" | "none";

export interface ColumnRoute {
  column: string;
  route: RouteKind;
  reason: string;
}

/**
 * Name tokens that mark a column as identifier-like. Matched as whole
 * tokens only (after splitting on non-alnum and camelCase boundaries),
 * never as a substring — a substring match (e.g. "id" inside "is_valid")
 * would false-positive far more often than the token-based match misses
 * (e.g. a one-word "zipcode" column with no separator). That's an
 * accepted, documented limitation: real column names in this codebase's
 * corpus and target schemas are snake_case, so the miss case is rare.
 */
const IDENTIFIER_NAME_WORDS = new Set(["id", "zip", "postal", "code", "phone", "account", "sku"]);

function isIdentifierLikeName(name: string): boolean {
  const withSeparators = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  const tokens = withSeparators.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((t) => IDENTIFIER_NAME_WORDS.has(t));
}

/**
 * A failing parse example is "suspicious" for coercion purposes if it
 * looks like a number wearing formatting the strict coercion functions
 * don't strip on their own (residualEval.ts's COERCE_NUMBER_PATTERN has
 * no currency/thousands-separator/percent/unit handling) — i.e. it has a
 * currency symbol, a percent sign, a thousands-grouped decimal, or a
 * trailing unit-like suffix after a digit.
 */
const CURRENCY_OR_UNIT_PATTERN = /[$€£¥%]|\d[.,]\d{3}\b|\d\s?[a-zA-Z]{1,4}$/;

function hasDigit(value: string): boolean {
  return /\d/.test(value);
}

function isSuspiciousFailingExample(value: string): boolean {
  return hasDigit(value) && CURRENCY_OR_UNIT_PATTERN.test(value);
}

function hasMissingValueSignal(stats: ColumnStats): boolean {
  return stats.missingTokenCount > 0 || stats.emptyStringCount > 0 || stats.whitespaceOnlyCount > 0;
}

function hasCoercionSignal(stats: ColumnStats): boolean {
  if (!stats.isTextColumn || !stats.parseRates) return false;
  for (const stat of Object.values(stats.parseRates)) {
    if (!stat) continue;
    if (stat.passed > 0) return true;
    if (stat.failingExamples.some(isSuspiciousFailingExample)) return true;
  }
  return false;
}

/** True if this column should never get a coercion proposal, regardless of parse-rate signal. */
function isIdentifierLike(stats: ColumnStats): boolean {
  return isIdentifierLikeName(stats.name) || stats.hasLeadingZeroStrings;
}

export function routeColumn(stats: ColumnStats): ColumnRoute {
  const missing = hasMissingValueSignal(stats);
  const coercionCandidate = hasCoercionSignal(stats);
  const identifierLike = coercionCandidate && isIdentifierLike(stats);
  const coercion = coercionCandidate && !identifierLike;

  if (missing && coercion) {
    return { column: stats.name, route: "both", reason: "missing-value tokens present and column has a coercible numeric/date/boolean signal" };
  }
  if (missing && identifierLike) {
    return {
      column: stats.name,
      route: "missing-value",
      reason: "missing-value tokens present; coercion signal present but column is identifier-like, skipped",
    };
  }
  if (missing) {
    return { column: stats.name, route: "missing-value", reason: "missing-value tokens present" };
  }
  if (coercion) {
    return { column: stats.name, route: "coercion", reason: "column has a coercible numeric/date/boolean signal" };
  }
  if (identifierLike) {
    return { column: stats.name, route: "none", reason: "coercion signal present but column is identifier-like, skipped" };
  }
  return { column: stats.name, route: "none", reason: "no missing-value or coercion signal" };
}

export function routeColumns(columns: ColumnStats[]): ColumnRoute[] {
  return columns.map(routeColumn);
}
