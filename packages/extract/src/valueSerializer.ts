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

/** Parses "+02:00" / "-0500" style offsets (sign + 2-digit hour + optional colon + 2-digit minute) into signed minutes. */
function parseOffsetMinutes(offset: string): number {
  const sign = offset[0] === "-" ? -1 : 1;
  const digits = offset.slice(1).replace(":", "");
  const oh = Number(digits.slice(0, 2));
  const om = Number(digits.slice(2, 4));
  return sign * (oh * 60 + om);
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
      if (raw instanceof Date) {
        if (Number.isNaN(raw.getTime())) throw new ValueSerializationError(`invalid datetime value: ${String(raw)}`);
        return raw.toISOString();
      }
      // Deliberately never delegates to `new Date(arbitrary string)`:
      // engines vary in how leniently they parse non-standard fractional
      // precision (driver text can carry up to 7 digits) and
      // space-before-offset forms, which would be an unacceptable source
      // of nondeterminism for exactness-tested values. Always parsed by
      // hand instead.
      const s = String(raw);
      const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
      if (!m) throw new ValueSerializationError(`invalid datetime value: ${s}`);
      const [, y, mo, d, h, mi, se, frac, offset] = m as unknown as [string, string, string, string, string, string, string, string | undefined, string | undefined];
      // Resolve only the integer Y/M/D/H/Mi/S fields through Date math
      // (ms fixed at 0 — no rounding carry into the seconds digit). A
      // timezone/offset shift is always a whole number of minutes, so it
      // can never touch the fractional-second digits — those are carried
      // through verbatim below, never rounded through a millisecond-only
      // `Date`/`toISOString()` (which would silently truncate
      // datetime2(7)'s 100ns precision down to 3 digits).
      let utc: Date;
      if (!offset) {
        // No zone info: a naive wall-clock reading, interpreted in sourceTimeZone.
        utc = zonedWallClockToUtc(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(se), 0, sourceTimeZone);
      } else {
        // Carries its own offset (or "Z") already — converted directly, sourceTimeZone ignored.
        const offsetMinutes = offset === "Z" ? 0 : parseOffsetMinutes(offset);
        utc = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se), 0) - offsetMinutes * 60_000);
      }
      if (Number.isNaN(utc.getTime())) throw new ValueSerializationError(`invalid datetime value: ${s}`);
      const datePart = `${pad(utc.getUTCFullYear(), 4)}-${pad(utc.getUTCMonth() + 1, 2)}-${pad(utc.getUTCDate(), 2)}`;
      const timePart = `${pad(utc.getUTCHours(), 2)}:${pad(utc.getUTCMinutes(), 2)}:${pad(utc.getUTCSeconds(), 2)}`;
      return `${datePart}T${timePart}.${frac ?? "000"}Z`;
    }
    default: {
      const exhaustive: never = type;
      throw new ValueSerializationError(`unsupported type: ${exhaustive as string}`);
    }
  }
}
