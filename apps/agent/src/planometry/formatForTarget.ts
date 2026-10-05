/**
 * docs/plans/planometry-v4-migration.md §3 "Values" / §10 slice A3: given a
 * mapped source column's raw driver value, produce the exact wire value for
 * its Planometry target column type. Formatting depends on the *target*
 * type, so it happens after mapping — this is new code, not
 * packages/extract/src/valueSerializer.ts unchanged (that file only knows
 * the *source* `ExtractType`, with no notion of a Planometry target type).
 *
 * `createFormatter` builds one formatter per mapped column, once per job —
 * never per value. In particular any `Intl.DateTimeFormat` needed for a
 * no-offset datetime->DateTime conversion is constructed once inside
 * `createFormatter` and reused by every call to the returned function, not
 * reconstructed per row (unlike valueSerializer.ts's `zonedWallClockToUtc`,
 * which deliberately isn't reused here for that reason).
 */
import type { ExtractType } from "@nia/extract";
import type { ColumnType } from "./types.js";
import { isTypeCompatible } from "./typeCompatibility.js";

export class FormatForTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatForTargetError";
  }
}

export type WireValue = string | number | boolean | null;

/** Built once per mapped column (via `createFormatter`), called once per row value. */
export type ColumnFormatter = (raw: unknown) => WireValue;

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** Parses "+02:00" / "-0500" style offsets (sign + 2-digit hour + optional colon + 2-digit minute) into signed minutes. */
function parseOffsetMinutes(offset: string): number {
  const sign = offset[0] === "-" ? -1 : 1;
  const digits = offset.slice(1).replace(":", "");
  const oh = Number(digits.slice(0, 2));
  const om = Number(digits.slice(2, 4));
  return sign * (oh * 60 + om);
}

const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}:?\d{2})?$/;

/** Exported for reuse by destinations/httpsFormat.ts, which needs the same no-offset-datetime->UTC conversion for a differently-shaped target. */
export interface ZoneProbe {
  dtf: Intl.DateTimeFormat;
}

export function buildZoneProbe(timeZone: string): ZoneProbe {
  return {
    dtf: new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
  };
}

/** Offset (ms) such that `localInstant = utcInstant + offset`, for the zone's reading of `utcInstantMs`. */
function offsetAtMs(utcInstantMs: number, zone: ZoneProbe): number {
  const parts = Object.fromEntries(zone.dtf.formatToParts(new Date(utcInstantMs)).map((p) => [p.type, p.value]));
  const hour24 = parts.hour === "24" ? 0 : Number(parts.hour);
  const asIfUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour24, Number(parts.minute), Number(parts.second), 0);
  return asIfUtc - utcInstantMs;
}

/**
 * Converts a wall-clock "no timezone" datetime into a real UTC instant,
 * interpreting it as having occurred in `zone`. Reuses one cached
 * `Intl.DateTimeFormat` (built once per column by `createFormatter`), and
 * resolves DST edges by iterating the offset to a fixed point rather than
 * trusting a single naive guess (a single guess is wrong for ordinary,
 * unambiguous wall-clock times that fall shortly after a forward
 * transition — e.g. 03:30 local on a US spring-forward day resolves to the
 * wrong UTC instant from one guess alone, confirmed empirically).
 *
 * DST rule — a local time that occurs twice (e.g. the repeated hour during
 * a fall-back): the iteration below starts from the offset in effect at
 * the naive "treat the digits as UTC" guess, which always lands before the
 * transition for a repeated hour; it converges there, so the EARLIER of
 * the two UTC instants (the pre-transition/DST offset) is chosen.
 *
 * DST rule — a local time that does not exist (e.g. inside a spring-
 * forward gap): no UTC instant reproduces it, so the offset oscillates
 * between the two neighbouring offsets instead of converging. After a
 * fixed 3-probe cap the loop always lands back on the candidate computed
 * from the POST-transition offset (the "spring forward" convention used
 * by most datetime libraries) — i.e. the gap time is treated as if the
 * clock had already advanced past it.
 */
function zonedWallClockToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, zone: ZoneProbe): Date {
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, s, 0);
  let candidate = wallAsUtc;
  let prevOffset: number | undefined;
  for (let i = 0; i < 3; i++) {
    const offset = offsetAtMs(candidate, zone);
    candidate = wallAsUtc - offset;
    if (offset === prevOffset) break;
    prevOffset = offset;
  }
  return new Date(candidate);
}

/** Exported for reuse by destinations/httpsFormat.ts (same "date" wire rule). */
export function dateOnlyFromRaw(raw: unknown): string {
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) throw new FormatForTargetError(`invalid date value: ${String(raw)}`);
    return `${pad(raw.getUTCFullYear(), 4)}-${pad(raw.getUTCMonth() + 1, 2)}-${pad(raw.getUTCDate(), 2)}`;
  }
  const s = String(raw);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) throw new FormatForTargetError(`invalid date value: ${s}`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * Converts a datetime raw value to the wire DateTime format (UTC, `Z`
 * suffix, fractional seconds carried through verbatim). `zone` is required
 * only for a no-offset value — a value carrying its own offset (or "Z")
 * converts directly and ignores `zone` entirely.
 */
/** Exported for reuse by destinations/httpsFormat.ts (same UTC-with-Z wire rule). */
export function datetimeToUtcIso(raw: unknown, zone: ZoneProbe | undefined): string {
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) throw new FormatForTargetError(`invalid datetime value: ${String(raw)}`);
    return raw.toISOString();
  }
  const s = String(raw);
  const m = DATETIME_RE.exec(s);
  if (!m) throw new FormatForTargetError(`invalid datetime value: ${s}`);
  const [, y, mo, d, h, mi, se, frac, offset] = m as unknown as [string, string, string, string, string, string, string, string | undefined, string | undefined];

  let utc: Date;
  if (!offset) {
    if (!zone) {
      throw new FormatForTargetError(
        "a DateTime target mapped from a no-offset datetime source requires sourceTimeZone on the connection, but none is set",
      );
    }
    utc = zonedWallClockToUtc(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(se), zone);
  } else {
    const offsetMinutes = offset === "Z" ? 0 : parseOffsetMinutes(offset);
    utc = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se), 0) - offsetMinutes * 60_000);
  }
  if (Number.isNaN(utc.getTime())) throw new FormatForTargetError(`invalid datetime value: ${s}`);
  const datePart = `${pad(utc.getUTCFullYear(), 4)}-${pad(utc.getUTCMonth() + 1, 2)}-${pad(utc.getUTCDate(), 2)}`;
  const timePart = `${pad(utc.getUTCHours(), 2)}:${pad(utc.getUTCMinutes(), 2)}:${pad(utc.getUTCSeconds(), 2)}`;
  return `${datePart}T${timePart}.${frac ?? "000"}Z`;
}

/**
 * Expands scientific-notation numeric text (e.g. "1e-7", "1.23e+21") into
 * plain decimal digits, never exponent notation — Number.prototype's own
 * `toFixed`/`toString` fall back to exponential notation outside certain
 * magnitudes (e.g. `(1e21).toFixed(0)` is still `"1e+21"`), so this walks
 * the digits by hand instead.
 */
function expandExponential(text: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(text);
  if (!m) return text;
  const [, sign, intPart, fracPart = "", expStr] = m as unknown as [string, string, string, string | undefined, string];
  const exp = Number(expStr);
  const digits = intPart + fracPart;
  const pointPos = intPart.length + exp;
  if (pointPos <= 0) return `${sign}0.${"0".repeat(-pointPos)}${digits}`;
  if (pointPos >= digits.length) return `${sign}${digits}${"0".repeat(pointPos - digits.length)}`;
  return `${sign}${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
}

/** Exact-digit numeric string for a Number target — never exponent notation, no thousands separators. */
function plainNumericString(raw: unknown): string {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) throw new FormatForTargetError(`non-finite number value: ${raw}`);
    if (Number.isInteger(raw) && Math.abs(raw) < Number.MAX_SAFE_INTEGER) return String(raw);
    return expandExponential(raw.toString());
  }
  if (typeof raw === "string") {
    // decimal/money/bigint/float columns are selected as exact-text by the
    // SQL Server module already (never as a JS number) — this is already
    // exact digits in the common case; only normalized if it happens to
    // carry exponent notation.
    return /e/i.test(raw) ? expandExponential(raw) : raw;
  }
  throw new FormatForTargetError(`unsupported raw value for a Number target: ${typeof raw}`);
}

/**
 * Guards against a pipeline error: a value for a column declared
 * `noOffsetSource` (datetime/smalldatetime/datetime2 — never carries a
 * zone marker as stored) arriving here already carrying "Z" or a numeric
 * offset anyway. That can only mean something upstream (re-)introduced a
 * zone conversion before this, the single place conversion is meant to
 * happen — never a value to interpret or pass through.
 */
function assertNoOffset(raw: unknown): void {
  if (raw instanceof Date) return; // no textual offset marker to inspect
  const s = String(raw);
  const m = DATETIME_RE.exec(s);
  if (m?.[8]) {
    throw new FormatForTargetError(
      `datetime value "${s}" is declared as a no-offset source column but already carries a UTC offset — this is a pipeline error, not a value to convert`,
    );
  }
}

function formatText(sourceType: ExtractType, raw: unknown): string {
  switch (sourceType) {
    case "text":
      return String(raw);
    case "number":
      return plainNumericString(raw);
    case "date":
      return dateOnlyFromRaw(raw);
    case "boolean":
      return Boolean(raw) ? "true" : "false";
    case "datetime":
      // Text is the "any value, stored as given" escape hatch (guide §4) —
      // passed through verbatim, deliberately never zone-converted (that
      // would contradict Date's own "never shifted" rule for the same raw
      // value just because it's mapped to a different target column).
      return String(raw);
    default: {
      const exhaustive: never = sourceType;
      throw new FormatForTargetError(`unsupported source type: ${exhaustive as string}`);
    }
  }
}

/**
 * One mapped column's source type, target type, and (only used for a
 * no-offset datetime -> DateTime mapping) the connection's sourceTimeZone.
 */
export interface FormatColumnSpec {
  sourceType: ExtractType;
  targetType: ColumnType;
  sourceTimeZone?: string;
  /**
   * True when the source column is known to be from the no-offset
   * datetime family (datetime/smalldatetime/datetime2 — never
   * datetimeoffset). Enables `assertNoOffset`'s pipeline-error guard for
   * this column. Left unset (the default) preserves the pre-existing,
   * offset-shape-driven dispatch for any caller that doesn't know (or
   * doesn't need) this distinction.
   */
  noOffsetSource?: boolean;
}

/**
 * Builds a reusable formatter for one mapped column. Called once per job
 * (per mapped column), not once per row — this is where any per-column,
 * zone-dependent state (the cached `Intl.DateTimeFormat`) is constructed.
 * Throws for any `(sourceType, targetType)` pair not in
 * `typeCompatibility.ts`'s table, and for a no-offset-datetime->DateTime
 * mapping whose connection has no `sourceTimeZone` (docs/plans/
 * planometry-v4-migration.md §3: "No default timezone").
 */
export function createFormatter(spec: FormatColumnSpec): ColumnFormatter {
  const { sourceType, targetType, sourceTimeZone, noOffsetSource } = spec;
  if (!isTypeCompatible(sourceType, targetType)) {
    throw new FormatForTargetError(`source type "${sourceType}" cannot be mapped to target type "${targetType}"`);
  }

  const zone = targetType === "DateTime" ? (sourceTimeZone ? buildZoneProbe(sourceTimeZone) : undefined) : undefined;

  return (raw: unknown): WireValue => {
    if (raw === null || raw === undefined) return null;
    if (noOffsetSource && sourceType === "datetime") assertNoOffset(raw);
    switch (targetType) {
      case "Text":
        return formatText(sourceType, raw);
      case "Number":
        return plainNumericString(raw);
      case "Boolean":
        return Boolean(raw);
      case "Date":
        return dateOnlyFromRaw(raw);
      case "DateTime":
        return datetimeToUtcIso(raw, zone);
      default: {
        const exhaustive: never = targetType;
        throw new FormatForTargetError(`unsupported target type: ${exhaustive as string}`);
      }
    }
  };
}

/** One mapped column, formatter already built via `createFormatter`. */
export interface MappedColumnFormatter {
  source: string;
  target: string;
  format: ColumnFormatter;
}

/** A single pushed row: target column name -> wire value. */
export type WireRow = Record<string, WireValue>;

/**
 * Builds the wire row for one source row: only the mapped target columns,
 * keyed exactly as the saved snapshot spells them (docs/planometry/
 * connector-guide-v4.md §2.3: "rows ... keyed by column name exactly as
 * /schema spells them").
 */
export function buildWireRow(columns: MappedColumnFormatter[], sourceRow: Record<string, unknown>): WireRow {
  const row: WireRow = {};
  for (const c of columns) row[c.target] = c.format(sourceRow[c.source]);
  return row;
}

/** Builds the key-only row (for a `delete`) from the same mapped+formatted columns, restricted to `keyTargets`. */
export function buildKeyRow(columns: MappedColumnFormatter[], sourceRow: Record<string, unknown>, keyTargets: string[]): WireRow {
  const keySet = new Set(keyTargets);
  const row: WireRow = {};
  for (const c of columns) {
    if (keySet.has(c.target)) row[c.target] = c.format(sourceRow[c.source]);
  }
  return row;
}
