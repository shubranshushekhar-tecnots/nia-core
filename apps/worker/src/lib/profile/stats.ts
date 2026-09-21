import { evalExpr, type Expr } from "@nia/schemas";
import {
  COERCION_PARSE_KEYS,
  DATE_FORMAT_CANDIDATES,
  MAX_EXAMPLE_VALUES,
  MAX_EXAMPLE_VALUE_CHARS,
  MISSING_VALUE_TOKENS,
  type ColumnStats,
  type ParseRateStat,
  type ParseStatKey,
} from "@nia/schemas";

/**
 * Phase 10 Step 3B — pure per-column stats. No I/O: takes the raw sample
 * values a column had across every sampled row (driver-deserialized JS
 * values, same shapes evalExpr's callers elsewhere in this codebase
 * already assume — real `Date` instances for date/timestamp columns, not
 * strings). Reuses @nia/schemas' residual evaluator (evalExpr) for every
 * parse-rate stat, per the plan's explicit "not separate heuristics"
 * instruction — this file adds no new number/date-parsing logic of its
 * own, it only builds the synthetic single-field `{v: value}` row/Expr
 * pair each call needs and tallies pass/fail.
 */

function truncateExample(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > MAX_EXAMPLE_VALUE_CHARS ? s.slice(0, MAX_EXAMPLE_VALUE_CHARS) : s;
}

function classifyValue(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (v instanceof Date) return "date";
  if (typeof v === "string") return "string";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  return "other";
}

function fieldExpr(): Expr {
  return { kind: "field", name: "v" };
}

/** Runs one coercion/parse call fn against every attempted string value, via evalExpr — no bespoke parsing. */
function computeParseRate(fn: ParseStatKey, dateToken: string | null, attempted: string[]): ParseRateStat {
  const expr: Expr =
    dateToken === null
      ? { kind: "call", fn: fn as Extract<Expr, { kind: "call" }>["fn"], args: [fieldExpr()] }
      : { kind: "call", fn: "parse_date", args: [fieldExpr(), { kind: "literal", value: dateToken }] };

  let passed = 0;
  const failingExamples: string[] = [];
  for (const raw of attempted) {
    const result = evalExpr(expr, { v: raw });
    if (result !== null && result !== undefined) {
      passed += 1;
    } else if (failingExamples.length < MAX_EXAMPLE_VALUES) {
      failingExamples.push(truncateExample(raw));
    }
  }
  return { attempted: attempted.length, passed, failingExamples };
}

export function computeColumnStats(name: string, declaredType: string, values: unknown[]): ColumnStats {
  const sampleCount = values.length;
  let nullCount = 0;
  let emptyStringCount = 0;
  let whitespaceOnlyCount = 0;
  let missingTokenCount = 0;
  const observedTypes = new Set<string>();
  const distinctKeys = new Set<string>();
  const nonNullStrings: string[] = [];
  const numbers: number[] = [];
  const dates: Date[] = [];
  let allNonNullAreStrings = true;
  let allNonNullAreNumbers = true;
  let allNonNullAreDates = true;
  let sawNonNull = false;

  for (const v of values) {
    observedTypes.add(classifyValue(v));
    distinctKeys.add(v instanceof Date ? `date:${v.toISOString()}` : JSON.stringify(v));

    if (v === null || v === undefined) {
      nullCount += 1;
      continue;
    }
    sawNonNull = true;
    if (typeof v !== "number") allNonNullAreNumbers = false;
    else numbers.push(v);
    if (!(v instanceof Date)) allNonNullAreDates = false;
    else dates.push(v);

    if (typeof v !== "string") {
      allNonNullAreStrings = false;
      continue;
    }
    nonNullStrings.push(v);
    if (v.length === 0) emptyStringCount += 1;
    else if (v.trim().length === 0) whitespaceOnlyCount += 1;
    if (MISSING_VALUE_TOKENS.has(v.trim().toLowerCase())) missingTokenCount += 1;
  }

  const isTextColumn = sawNonNull && allNonNullAreStrings;
  const isNumericColumn = sawNonNull && allNonNullAreNumbers;
  const isDateColumn = sawNonNull && allNonNullAreDates;

  let parseRates: ColumnStats["parseRates"] = null;
  let minLength: number | null = null;
  let maxLength: number | null = null;
  if (isTextColumn) {
    const rates: Partial<Record<ParseStatKey, ParseRateStat>> = {};
    for (const key of COERCION_PARSE_KEYS) rates[key] = computeParseRate(key, null, nonNullStrings);
    for (const { key, token } of DATE_FORMAT_CANDIDATES) rates[key] = computeParseRate(key, token, nonNullStrings);
    parseRates = rates as Record<ParseStatKey, ParseRateStat>;
    if (nonNullStrings.length > 0) {
      minLength = Math.min(...nonNullStrings.map((s) => s.length));
      maxLength = Math.max(...nonNullStrings.map((s) => s.length));
    }
  }

  let min: number | string | null = null;
  let max: number | string | null = null;
  if (isNumericColumn && numbers.length > 0) {
    min = Math.min(...numbers);
    max = Math.max(...numbers);
  } else if (isDateColumn && dates.length > 0) {
    const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
    min = sorted[0]!.toISOString();
    max = sorted[sorted.length - 1]!.toISOString();
  }

  return {
    name,
    declaredType,
    observedTypes: [...observedTypes].sort(),
    sampleCount,
    nullCount,
    emptyStringCount,
    whitespaceOnlyCount,
    distinctCount: distinctKeys.size,
    missingTokenCount,
    isTextColumn,
    parseRates,
    min,
    max,
    minLength,
    maxLength,
  };
}
