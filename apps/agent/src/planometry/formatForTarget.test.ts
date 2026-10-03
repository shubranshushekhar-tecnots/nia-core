import { describe, expect, it } from "vitest";
import {
  FormatForTargetError,
  buildKeyRow,
  buildWireRow,
  createFormatter,
  type MappedColumnFormatter,
} from "./formatForTarget.js";

describe("createFormatter: Date target", () => {
  it("datetime2 to Date keeps the local date for a timezone ahead of UTC", () => {
    // datetime2 collapses to ExtractType "datetime" before it reaches here (nativeTypeMapping.ts).
    // sourceTimeZone is set to a zone ahead of UTC (+9) on purpose: if Date conversion ever went
    // through a UTC step this near-midnight value would roll onto the next day. It must not.
    const format = createFormatter({ sourceType: "datetime", targetType: "Date", sourceTimeZone: "Asia/Tokyo" });
    expect(format("2024-01-01T23:30:00.000")).toBe("2024-01-01");
  });

  it("datetimeoffset to Date takes the date at its own offset", () => {
    const format = createFormatter({ sourceType: "datetime", targetType: "Date" });
    // UTC for this instant is 2024-06-14 (the day before) — the Date target must keep the
    // date as written at the value's own offset, never the UTC-shifted date.
    expect(format("2024-06-15T01:30:00.0000000+05:30")).toBe("2024-06-15");
  });

  it("date to Date is unchanged", () => {
    const format = createFormatter({ sourceType: "date", targetType: "Date" });
    expect(format("2024-07-04")).toBe("2024-07-04");
  });
});

describe("createFormatter: DateTime target", () => {
  it("datetime to DateTime converts with sourceTimeZone to Z", () => {
    const format = createFormatter({ sourceType: "datetime", targetType: "DateTime", sourceTimeZone: "America/New_York" });
    // 2024-06-15 is EDT (UTC-4).
    expect(format("2024-06-15T10:30:00.000")).toBe("2024-06-15T14:30:00.000Z");
  });

  it("datetimeoffset to DateTime uses its own offset (sourceTimeZone ignored)", () => {
    const format = createFormatter({ sourceType: "datetime", targetType: "DateTime", sourceTimeZone: "Pacific/Kiritimati" });
    expect(format("2024-06-15T10:30:00.0000000+05:30")).toBe("2024-06-15T05:00:00.0000000Z");
  });

  it("keeps the source's fractional seconds", () => {
    const format = createFormatter({ sourceType: "datetime", targetType: "DateTime" });
    expect(format("2024-06-15T10:30:00.1234567+00:00")).toBe("2024-06-15T10:30:00.1234567Z");
  });

  it("a local time that occurs twice resolves to the earlier (pre-transition) instant", () => {
    // America/New_York fall-back: 2026-11-01, clocks go 02:00 -> 01:00, so 01:30 occurs twice
    // (first at EDT/UTC-4, again an hour later at EST/UTC-5). Verified against ground truth via
    // direct Intl probing: the earlier (EDT) occurrence is 05:30Z.
    const format = createFormatter({ sourceType: "datetime", targetType: "DateTime", sourceTimeZone: "America/New_York" });
    expect(format("2026-11-01T01:30:00.000")).toBe("2026-11-01T05:30:00.000Z");
  });

  it("a local time that does not exist resolves via the post-transition (spring-forward) offset", () => {
    // America/New_York spring-forward: 2026-03-08, clocks jump 02:00 -> 03:00, so 02:30 never
    // happens. Ground-truth checked: resolves to the same instant as 03:30 EDT (07:30Z) — i.e.
    // the gap time is treated as if the clock had already advanced past it.
    const format = createFormatter({ sourceType: "datetime", targetType: "DateTime", sourceTimeZone: "America/New_York" });
    expect(format("2026-03-08T02:30:00.000")).toBe("2026-03-08T07:30:00.000Z");
  });

  it("refuses a no-offset datetime without sourceTimeZone", () => {
    const format = createFormatter({ sourceType: "datetime", targetType: "DateTime" });
    expect(() => format("2024-06-15T10:30:00.000")).toThrow(FormatForTargetError);
  });
});

describe("createFormatter: Number target", () => {
  it("bigint above 2^53 is exact", () => {
    const format = createFormatter({ sourceType: "number", targetType: "Number" });
    expect(format("9223372036854775807")).toBe("9223372036854775807");
  });

  it("decimal with many digits is exact", () => {
    const format = createFormatter({ sourceType: "number", targetType: "Number" });
    expect(format("12345678901234567890.123456789012345")).toBe("12345678901234567890.123456789012345");
  });

  it("float 1e-7 and 1e21 are never exponent notation", () => {
    const format = createFormatter({ sourceType: "number", targetType: "Number" });
    expect(format(1e-7)).toBe("0.0000001");
    expect(format(1e21)).toBe("1000000000000000000000");
  });
});

describe("createFormatter: Boolean target", () => {
  it("bit to Boolean", () => {
    const format = createFormatter({ sourceType: "boolean", targetType: "Boolean" });
    expect(format(true)).toBe(true);
    expect(format(false)).toBe(false);
  });
});

describe("createFormatter: Text target", () => {
  it("uniqueidentifier and time pass through as text", () => {
    const format = createFormatter({ sourceType: "text", targetType: "Text" });
    expect(format("3F2504E0-4F89-11D3-9A0C-0305E82C3301")).toBe("3F2504E0-4F89-11D3-9A0C-0305E82C3301");
    expect(format("13:45:30")).toBe("13:45:30");
  });
});

describe("createFormatter: null", () => {
  it("null stays null for every target type", () => {
    expect(createFormatter({ sourceType: "text", targetType: "Text" })(null)).toBeNull();
    expect(createFormatter({ sourceType: "number", targetType: "Number" })(null)).toBeNull();
    expect(createFormatter({ sourceType: "date", targetType: "Date" })(null)).toBeNull();
    expect(createFormatter({ sourceType: "datetime", targetType: "DateTime", sourceTimeZone: "UTC" })(null)).toBeNull();
    expect(createFormatter({ sourceType: "boolean", targetType: "Boolean" })(null)).toBeNull();
  });
});

describe("createFormatter: disallowed pairs", () => {
  it("throws for a type pair not in the compatibility table", () => {
    expect(() => createFormatter({ sourceType: "text", targetType: "Number" })).toThrow(FormatForTargetError);
  });
});

describe("row mapping", () => {
  function col(source: string, target: string, value: string): MappedColumnFormatter {
    return { source, target, format: () => value };
  }

  it("wire row holds only mapped target columns, keyed exactly as spelled", () => {
    const columns = [col("Id", "CustomerId", "1"), col("Name", "FullName", "Ann")];
    const row = buildWireRow(columns, { Id: "1", Name: "Ann" });
    expect(row).toEqual({ CustomerId: "1", FullName: "Ann" });
  });

  it("key-only row holds only key columns", () => {
    const columns = [col("Id", "CustomerId", "1"), col("Name", "FullName", "Ann")];
    const row = buildKeyRow(columns, { Id: "1", Name: "Ann" }, ["CustomerId"]);
    expect(row).toEqual({ CustomerId: "1" });
  });
});
