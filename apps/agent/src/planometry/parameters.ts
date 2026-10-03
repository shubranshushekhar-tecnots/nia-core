/**
 * Named-parameter filters for sync jobs (docs/plans/planometry-v4-
 * migration.md §2, §10 slice B1): a job's filter is a list of
 * FilterCondition-shaped conditions (from `@nia/extract`) where any value
 * position may instead be a `ParamRef` (`{ param: "name" }`). Resolved
 * into a real `FilterCondition[]` by `resolveJobFilter` before being
 * handed to `@nia/extract`'s `filterBuilder.ts`, which is used unchanged.
 *
 * Deliberately out of scope for this slice (item 4, arrives in C1): a
 * changed filter forcing a replace, and relative-date parameters
 * requiring a replace schedule.
 */
import type { ExtractType, FilterCondition, FilterScalar } from "@nia/extract";

export class ParameterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParameterError";
  }
}

/** A filter value position that references a named parameter instead of carrying a literal. */
export interface ParamRef {
  param: string;
}

function isParamRef(value: unknown): value is ParamRef {
  return typeof value === "object" && value !== null && typeof (value as { param?: unknown }).param === "string";
}

export type FilterValueOrParam = FilterScalar | ParamRef;

/**
 * Same shape as `@nia/extract`'s `FilterCondition`, except every value
 * position may be a `ParamRef`. Filter columns come from the source
 * catalog and need not be in the job's mapping.
 */
export type JobFilterCondition =
  | { column: string; operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "startsWith"; value: FilterValueOrParam }
  | { column: string; operator: "in"; values: FilterValueOrParam[] }
  | { column: string; operator: "between"; low: FilterValueOrParam; high: FilterValueOrParam }
  | { column: string; operator: "isNull" | "isNotNull" };

const TODAY_OFFSET_RE = /^today([+-]\d+)d$/;
const MONTH_OFFSET_RE = /^startOfMonth-(\d+)m$/;
const YEAR_OFFSET_RE = /^startOfYear-(\d+)y$/;

/** The only expressions a parameter value may hold besides a literal: `today`, `today±Nd`, `startOfMonth`, `startOfMonth-Nm`, `startOfYear`, `startOfYear-Ny`. */
export function isRelativeDateToken(value: string): boolean {
  return (
    value === "today" ||
    TODAY_OFFSET_RE.test(value) ||
    value === "startOfMonth" ||
    MONTH_OFFSET_RE.test(value) ||
    value === "startOfYear" ||
    YEAR_OFFSET_RE.test(value)
  );
}

interface WallClockDate {
  y: number;
  mo: number; // 1-12
  d: number;
}

/** The zone's wall-clock reading of `now`, via `Intl.DateTimeFormat` (same technique as formatForTarget.ts's zone probe, independently built here since the inputs differ). */
function wallClockNow(timeZone: string, now: Date): WallClockDate {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = Object.fromEntries(dtf.formatToParts(now).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day) };
}

function formatYmd(y: number, mo: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Adds `deltaDays` (may be negative) to a Y/M/D, via UTC-anchored millisecond arithmetic so calendar rollovers (leap years, month lengths) resolve correctly. */
function addDaysUtc(y: number, mo: number, d: number, deltaDays: number): WallClockDate {
  const dt = new Date(Date.UTC(y, mo - 1, d) + deltaDays * 86_400_000);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** Resolves a relative-date token to a plain `YYYY-MM-DD`, reading "today" from `timeZone`'s wall clock at instant `now`. */
export function resolveRelativeDateToken(token: string, timeZone: string, now: Date): string {
  const base = wallClockNow(timeZone, now);
  if (token === "today") return formatYmd(base.y, base.mo, base.d);
  const todayMatch = TODAY_OFFSET_RE.exec(token);
  if (todayMatch) {
    const r = addDaysUtc(base.y, base.mo, base.d, Number(todayMatch[1]));
    return formatYmd(r.y, r.mo, r.d);
  }
  if (token === "startOfMonth") return formatYmd(base.y, base.mo, 1);
  const monthMatch = MONTH_OFFSET_RE.exec(token);
  if (monthMatch) {
    const totalMonths = base.y * 12 + (base.mo - 1) - Number(monthMatch[1]);
    const y = Math.floor(totalMonths / 12);
    const mo = ((totalMonths % 12) + 12) % 12 + 1;
    return formatYmd(y, mo, 1);
  }
  if (token === "startOfYear") return formatYmd(base.y, 1, 1);
  const yearMatch = YEAR_OFFSET_RE.exec(token);
  if (yearMatch) return formatYmd(base.y - Number(yearMatch[1]), 1, 1);
  throw new ParameterError(`not a recognized relative-date token: ${JSON.stringify(token)}`);
}

/** Type-checks a literal value already carrying a JS type (from the filter JSON, not a `--param`). */
function checkLiteralType(columnType: ExtractType, column: string, value: FilterScalar): void {
  if (columnType === "number" && typeof value !== "number") {
    throw new ParameterError(`filter on ${JSON.stringify(column)}: literal value ${JSON.stringify(value)} is not a number for a number column`);
  }
  if (columnType === "boolean" && typeof value !== "boolean") {
    throw new ParameterError(`filter on ${JSON.stringify(column)}: literal value ${JSON.stringify(value)} is not true/false for a boolean column`);
  }
  if ((columnType === "date" || columnType === "datetime") && typeof value !== "string") {
    throw new ParameterError(`filter on ${JSON.stringify(column)}: literal value ${JSON.stringify(value)} is not a date literal for a ${columnType} column`);
  }
}

/** Type-checks and coerces a `--param`-sourced string (always a raw string, possibly a relative-date token) against the filtered column's type. */
function coerceParamValue(columnType: ExtractType, column: string, paramName: string, raw: string, timeZone: string, now: Date): FilterScalar {
  const isToken = isRelativeDateToken(raw);
  if (isToken && columnType !== "date" && columnType !== "datetime") {
    throw new ParameterError(
      `filter on ${JSON.stringify(column)}: parameter ${JSON.stringify(paramName)} is a relative-date token but the column is ${columnType}, not date/datetime`,
    );
  }
  if (columnType === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new ParameterError(`filter on ${JSON.stringify(column)}: parameter ${JSON.stringify(paramName)} = ${JSON.stringify(raw)} is not a valid number`);
    }
    return n;
  }
  if (columnType === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new ParameterError(`filter on ${JSON.stringify(column)}: parameter ${JSON.stringify(paramName)} = ${JSON.stringify(raw)} is not "true" or "false"`);
  }
  if (columnType === "date" || columnType === "datetime") {
    if (isToken) {
      const ymd = resolveRelativeDateToken(raw, timeZone, now);
      // No-offset date-time columns are bound as a wall-clock value, never converted to UTC (same contract as formatForTarget.ts's noOffsetSource path).
      return columnType === "date" ? ymd : `${ymd}T00:00:00.000`;
    }
    if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) {
      throw new ParameterError(
        `filter on ${JSON.stringify(column)}: parameter ${JSON.stringify(paramName)} = ${JSON.stringify(raw)} is not a valid date literal or relative-date token`,
      );
    }
    return raw;
  }
  return raw; // text
}

function resolveValueOrParam(
  valueOrParam: FilterValueOrParam,
  columnType: ExtractType,
  column: string,
  params: Record<string, string>,
  timeZone: string,
  now: Date,
  resolvedParams: Record<string, FilterScalar>,
): FilterScalar {
  if (isParamRef(valueOrParam)) {
    const raw = params[valueOrParam.param];
    if (raw === undefined) {
      throw new ParameterError(`filter on ${JSON.stringify(column)}: parameter ${JSON.stringify(valueOrParam.param)} has no value`);
    }
    const resolved = coerceParamValue(columnType, column, valueOrParam.param, raw, timeZone, now);
    resolvedParams[valueOrParam.param] = resolved;
    return resolved;
  }
  checkLiteralType(columnType, column, valueOrParam);
  return valueOrParam;
}

function resolveCondition(
  cond: JobFilterCondition,
  columnTypes: Record<string, ExtractType>,
  params: Record<string, string>,
  timeZone: string,
  now: Date,
  resolvedParams: Record<string, FilterScalar>,
): FilterCondition {
  const columnType = columnTypes[cond.column];
  if (columnType === undefined) {
    throw new ParameterError(`filter references unknown column ${JSON.stringify(cond.column)}`);
  }
  // A switch (not if/else) — TS only narrows the `operator: "isNull" | "isNotNull"` variant out of the union via per-case narrowing, same as filterBuilder.ts's compileWhereClause.
  switch (cond.operator) {
    case "isNull":
    case "isNotNull":
      return { column: cond.column, operator: cond.operator };
    case "in":
      return {
        column: cond.column,
        operator: "in",
        values: cond.values.map((v) => resolveValueOrParam(v, columnType, cond.column, params, timeZone, now, resolvedParams)),
      };
    case "between":
      return {
        column: cond.column,
        operator: "between",
        low: resolveValueOrParam(cond.low, columnType, cond.column, params, timeZone, now, resolvedParams),
        high: resolveValueOrParam(cond.high, columnType, cond.column, params, timeZone, now, resolvedParams),
      };
    default:
      return {
        column: cond.column,
        operator: cond.operator,
        value: resolveValueOrParam(cond.value, columnType, cond.column, params, timeZone, now, resolvedParams),
      };
  }
}

export interface ResolvedJobFilter {
  filter: FilterCondition[];
  /** Resolved values actually bound, keyed by parameter name — for the run summary/log (item 3). */
  resolvedParams: Record<string, FilterScalar>;
}

/**
 * Resolves a job's filter against its saved params (overridden per-run by
 * `overrideParams`, which is never persisted) and the source catalog's
 * column types. Throws `ParameterError` — refusing before extraction —
 * on an unknown column, a missing parameter value, a type mismatch, or a
 * relative-date token on a non-date column.
 */
export function resolveJobFilter(
  jobFilter: JobFilterCondition[],
  columnTypes: Record<string, ExtractType>,
  savedParams: Record<string, string>,
  overrideParams: Record<string, string> | undefined,
  timeZone: string,
  now: Date = new Date(),
): ResolvedJobFilter {
  const params = { ...savedParams, ...(overrideParams ?? {}) };
  const resolvedParams: Record<string, FilterScalar> = {};
  const filter = jobFilter.map((cond) => resolveCondition(cond, columnTypes, params, timeZone, now, resolvedParams));
  return { filter, resolvedParams };
}

/** Parses repeatable `--param name=value` CLI entries, mirroring jobMapping.ts's `parseMapOverrides`. */
export function parseParamOverrides(raw: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of raw) {
    const eq = entry.indexOf("=");
    if (eq === -1) throw new ParameterError(`--param must be formatted as name=value, got ${JSON.stringify(entry)}`);
    result[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return result;
}
