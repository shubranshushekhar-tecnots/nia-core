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
 * Serializes a single raw driver value into the exact wire format the
 * Planometry contract requires (docs/plans/planometry-integration.md).
 * Time-zone interpretation of a no-offset `datetime` value is NOT done
 * here — see the "datetime" case below — it happens exactly once, in
 * apps/agent/src/planometry/formatForTarget.ts, which is target-type
 * aware (a Date target must never be zone-shifted; a DateTime target
 * must be). A value that already carries its own offset (`datetimeoffset`)
 * is still converted to UTC directly here, unchanged — that's plain
 * arithmetic on an unambiguous instant, not a zone interpretation.
 */
export function serializeValue(type: ExtractType, raw: unknown): string | number | boolean | null {
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
      if (!offset) {
        // No zone info: a naive wall-clock reading (datetime/smalldatetime/
        // datetime2) — the ONLY behaviour now: pass it through exactly as
        // stored (reassembled from the validated digits, not re-parsed
        // through a millisecond-only Date, so fractional precision beyond
        // 3 digits is never touched). No zone interpretation happens here;
        // that is formatForTarget.ts's job, once it knows the target type.
        return `${y}-${mo}-${d}T${h}:${mi}:${se}.${frac ?? "000"}`;
      }
      // Carries its own offset (or "Z") already (datetimeoffset) — this is
      // an unambiguous instant, not a zone interpretation, so it's still
      // normalized to UTC directly here, unchanged.
      const offsetMinutes = offset === "Z" ? 0 : parseOffsetMinutes(offset);
      const utc = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se), 0) - offsetMinutes * 60_000);
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
