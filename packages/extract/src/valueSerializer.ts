import type { ExtractType } from "./types.js";

export class ValueSerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueSerializationError";
  }
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/**
 * Converts a wall-clock "no timezone" datetime (as read verbatim off the
 * wire from the driver, e.g. "2024-03-01T10:30:00.000") into a real UTC
 * instant, interpreting it as having occurred in `sourceTimeZone` (an IANA
 * name, e.g. "America/Chicago"). Uses only built-in `Intl` (no new
 * dependency): formats a UTC guess through the target zone, measures the
 * offset between the guess and what that zone displays, and corrects —
 * correct across DST because the offset is read for the guessed instant
 * itself, not a fixed table.
 */
function zonedWallClockToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number, timeZone: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const hour24 = parts.hour === "24" ? 0 : Number(parts.hour);
  const asIfUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour24, Number(parts.minute), Number(parts.second), ms);
  const offsetMs = asIfUtc - guess;
  return new Date(guess - offsetMs);
}

/**
 * Serializes a single raw driver value into the exact wire format the
 * Planometry contract requires (docs/plans/planometry-integration.md).
 * `sourceTimeZone` only matters for a `datetime` value that arrives with
 * no zone info (a naive wall-clock reading); a value that already carries
 * an offset (`datetimeoffset`) is converted to UTC directly, ignoring it.
 */
export function serializeValue(type: ExtractType, raw: unknown, sourceTimeZone: string): string | number | boolean | null {
  if (raw === null || raw === undefined) return null;
  switch (type) {
    case "boolean":
      return Boolean(raw);
    case "text":
      return String(raw);
    case "number":
      // The SQL Server module selects decimal/money/bigint/float columns
      // as exact-text in the query itself (never as a JS number), so
      // `raw` is already an exact digit string by the time it gets here.
      if (typeof raw === "number") {
        if (!Number.isFinite(raw)) throw new ValueSerializationError(`non-finite number value: ${raw}`);
        return String(raw);
      }
      if (typeof raw === "string") return raw;
      throw new ValueSerializationError(`unsupported raw value for "number": ${typeof raw}`);
    case "date": {
      const d = raw instanceof Date ? raw : new Date(String(raw));
      if (Number.isNaN(d.getTime())) throw new ValueSerializationError(`invalid date value: ${String(raw)}`);
      return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;
    }
    case "datetime": {
      let utc: Date;
      if (raw instanceof Date) {
        utc = raw;
      } else {
        const s = String(raw);
        const hasZone = /Z$|[+-]\d{2}:?\d{2}$/.test(s);
        if (hasZone) {
          utc = new Date(s);
        } else {
          const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?/.exec(s);
          if (!m) throw new ValueSerializationError(`invalid datetime value: ${s}`);
          const [, y, mo, d, h, mi, se, frac] = m as unknown as [string, string, string, string, string, string, string, string | undefined];
          const ms = frac ? Math.round(Number(`0.${frac}`) * 1000) : 0;
          utc = zonedWallClockToUtc(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(se), ms, sourceTimeZone);
        }
      }
      if (Number.isNaN(utc.getTime())) throw new ValueSerializationError(`invalid datetime value: ${String(raw)}`);
      return utc.toISOString();
    }
    default: {
      const exhaustive: never = type;
      throw new ValueSerializationError(`unsupported type: ${exhaustive as string}`);
    }
  }
}
