/**
 * Slice R2 (docs/plans/agent-canvas-integration.md §B.7): value rules for
 * the generic HTTPS destination — distinct from `planometry/
 * formatForTarget.ts`'s rules (which always emit Number as a decimal
 * string). Dates/date-times reuse that module's existing, already-tested
 * no-offset/DST-aware conversion helpers directly rather than duplicating
 * them.
 */
import type { ExtractType } from "@nia/extract";
import { buildZoneProbe, dateOnlyFromRaw, datetimeToUtcIso, type ZoneProbe } from "../planometry/formatForTarget.js";
import type { JobMappingColumn } from "../config/types.js";

export class HttpsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpsFormatError";
  }
}

export type HttpsWireValue = string | number | boolean | null;
export type HttpsColumnFormatter = (raw: unknown) => HttpsWireValue;

/**
 * Normalizes numeric text for an exact round-trip comparison against
 * `Number(s).toString()`: strips a leading "+", collapses leading zeros
 * on the integer part, and trims trailing zeros (and a now-bare decimal
 * point) off the fractional part. Used only to decide whether the
 * original text and its parsed-and-restringified form denote the exact
 * same digits — never used as the emitted value itself.
 */
function canonicalizeDecimal(s: string): string {
  let str = s.trim();
  let sign = "";
  if (str[0] === "+" || str[0] === "-") {
    sign = str[0] === "-" ? "-" : "";
    str = str.slice(1);
  }
  const [intRaw = "", fracRaw = ""] = str.split(".");
  let intPart = intRaw.replace(/^0+(?=\d)/, "");
  if (intPart === "") intPart = "0";
  const fracPart = fracRaw.replace(/0+$/, "");
  const body = fracPart ? `${intPart}.${fracPart}` : intPart;
  return body === "0" ? "0" : `${sign}${body}`;
}

/**
 * "numbers as JSON numbers when exactly representable, otherwise
 * strings" (task item 2). A raw JS `number` is always already exact. A
 * raw string (decimal/money/bigint/float columns are extracted as exact
 * text, never a JS number, for precisely this reason) is emitted as a
 * JSON number only when `Number(s)` round-trips back to the same digits;
 * otherwise the original text is preserved verbatim.
 */
function formatNumber(raw: unknown): HttpsWireValue {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) throw new HttpsFormatError(`non-finite number value: ${raw}`);
    return raw;
  }
  const s = String(raw);
  const n = Number(s);
  if (Number.isNaN(n)) throw new HttpsFormatError(`invalid number value: ${s}`);
  return canonicalizeDecimal(s) === canonicalizeDecimal(n.toString()) ? n : s;
}

export interface HttpsFormatColumnSpec {
  sourceType: ExtractType;
  /** Required to format a "datetime" column — see createFormatter's own identical requirement in formatForTarget.ts. */
  sourceTimeZone?: string;
}

/** Built once per mapped column (never per row) — same convention as `planometry/formatForTarget.ts`'s `createFormatter`. */
export function createHttpsFormatter(spec: HttpsFormatColumnSpec): HttpsColumnFormatter {
  const zone: ZoneProbe | undefined = spec.sourceTimeZone ? buildZoneProbe(spec.sourceTimeZone) : undefined;
  return (raw: unknown): HttpsWireValue => {
    if (raw === null || raw === undefined) return null;
    switch (spec.sourceType) {
      case "text":
        return String(raw);
      case "number":
        return formatNumber(raw);
      case "boolean":
        return Boolean(raw);
      case "date":
        return dateOnlyFromRaw(raw);
      case "datetime":
        return datetimeToUtcIso(raw, zone);
      default: {
        const exhaustive: never = spec.sourceType;
        throw new HttpsFormatError(`unsupported source type: ${exhaustive as string}`);
      }
    }
  };
}

export interface MappedHttpsColumnFormatter {
  source: string;
  output: string;
  format: HttpsColumnFormatter;
}

/** One formatter per mapped column, built once per run — mirrors `sync/runSync.ts`'s `buildFormatters`, but keyed by output name, not a Planometry target schema column. */
export function buildHttpsFormatters(
  mapping: JobMappingColumn[],
  sourceColumnTypes: Record<string, ExtractType>,
  sourceTimeZone: string | undefined,
): MappedHttpsColumnFormatter[] {
  return mapping.map((m) => {
    const sourceType = sourceColumnTypes[m.source];
    if (!sourceType) throw new HttpsFormatError(`no extracted type known for source column "${m.source}"`);
    return { source: m.source, output: m.target, format: createHttpsFormatter({ sourceType, sourceTimeZone }) };
  });
}

export type HttpsWireRow = Record<string, HttpsWireValue>;

export function buildHttpsWireRow(columns: MappedHttpsColumnFormatter[], sourceRow: Record<string, unknown>): HttpsWireRow {
  const row: HttpsWireRow = {};
  for (const c of columns) row[c.output] = c.format(sourceRow[c.source]);
  return row;
}
