import { describe, expect, it } from "vitest";
import { serializeValue, ValueSerializationError } from "./valueSerializer.js";

describe("serializeValue", () => {
  it("null/undefined always serialize to null", () => {
    expect(serializeValue("text", null)).toBeNull();
    expect(serializeValue("number", undefined)).toBeNull();
  });

  it("boolean passes through as a real boolean", () => {
    expect(serializeValue("boolean", true)).toBe(true);
    expect(serializeValue("boolean", 0)).toBe(false);
  });

  it("text stringifies as-is", () => {
    expect(serializeValue("text", "hello")).toBe("hello");
  });

  it("number passes an exact-digit string through unchanged (never via float)", () => {
    expect(serializeValue("number", "123456789012345678901234.1234567890")).toBe("123456789012345678901234.1234567890");
  });

  it("number rejects non-finite JS numbers", () => {
    expect(() => serializeValue("number", Infinity)).toThrow(ValueSerializationError);
  });

  it("date formats as yyyy-MM-dd from a Date", () => {
    expect(serializeValue("date", new Date(Date.UTC(2024, 2, 1)))).toBe("2024-03-01");
  });

  it("datetime with an explicit offset still converts to UTC with Z (datetimeoffset, unambiguous instant, unchanged)", () => {
    expect(serializeValue("datetime", "2024-03-01T10:30:00+02:00")).toBe("2024-03-01T08:30:00.000Z");
  });

  it("datetime with no zone info passes through as wall-clock text, unconverted (no-offset family: datetime/smalldatetime/datetime2)", () => {
    expect(serializeValue("datetime", "2024-03-01T10:30:00.000")).toBe("2024-03-01T10:30:00.000");
  });

  it("datetime rejects an invalid value", () => {
    expect(() => serializeValue("datetime", "not-a-date")).toThrow(ValueSerializationError);
  });

  it("datetime preserves sub-millisecond fractional-second digits exactly (e.g. datetime2(7)'s 100ns precision) through the no-offset passthrough", () => {
    expect(serializeValue("datetime", "2024-03-01T10:30:00.1234567")).toBe("2024-03-01T10:30:00.1234567");
  });

  it("datetime preserves full fractional precision through an explicit-offset conversion too", () => {
    expect(serializeValue("datetime", "2024-03-01T10:30:00.1234567+05:30")).toBe("2024-03-01T05:00:00.1234567Z");
  });
});
