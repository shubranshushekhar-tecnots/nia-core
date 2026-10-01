import { describe, expect, it } from "vitest";
import { serializeValue, ValueSerializationError } from "./valueSerializer.js";

describe("serializeValue", () => {
  it("null/undefined always serialize to null", () => {
    expect(serializeValue("text", null, "UTC")).toBeNull();
    expect(serializeValue("number", undefined, "UTC")).toBeNull();
  });

  it("boolean passes through as a real boolean", () => {
    expect(serializeValue("boolean", true, "UTC")).toBe(true);
    expect(serializeValue("boolean", 0, "UTC")).toBe(false);
  });

  it("text stringifies as-is", () => {
    expect(serializeValue("text", "hello", "UTC")).toBe("hello");
  });

  it("number passes an exact-digit string through unchanged (never via float)", () => {
    expect(serializeValue("number", "123456789012345678901234.1234567890", "UTC")).toBe("123456789012345678901234.1234567890");
  });

  it("number rejects non-finite JS numbers", () => {
    expect(() => serializeValue("number", Infinity, "UTC")).toThrow(ValueSerializationError);
  });

  it("date formats as yyyy-MM-dd from a Date", () => {
    expect(serializeValue("date", new Date(Date.UTC(2024, 2, 1)), "UTC")).toBe("2024-03-01");
  });

  it("datetime with an explicit zone converts to UTC with Z", () => {
    expect(serializeValue("datetime", "2024-03-01T10:30:00+02:00", "UTC")).toBe("2024-03-01T08:30:00.000Z");
  });

  it("datetime with no zone info is interpreted using sourceTimeZone", () => {
    // America/Chicago is UTC-6 in March (CST, before DST starts).
    expect(serializeValue("datetime", "2024-03-01T10:30:00.000", "America/Chicago")).toBe("2024-03-01T16:30:00.000Z");
  });

  it("datetime with no zone info respects DST in sourceTimeZone", () => {
    // America/Chicago is UTC-5 in July (CDT).
    expect(serializeValue("datetime", "2024-07-01T10:30:00.000", "America/Chicago")).toBe("2024-07-01T15:30:00.000Z");
  });

  it("datetime rejects an invalid value", () => {
    expect(() => serializeValue("datetime", "not-a-date", "UTC")).toThrow(ValueSerializationError);
  });
});
