import { describe, expect, it } from "vitest";
import { nativeTypeInfo } from "./nativeTypeMapping.js";

describe("nativeTypeInfo", () => {
  it("maps bit to boolean", () => {
    expect(nativeTypeInfo("bit")).toEqual({ extractType: "boolean", castToText: false });
  });

  it("maps uniqueidentifier and text-family types to text, casting only time", () => {
    expect(nativeTypeInfo("uniqueidentifier").extractType).toBe("text");
    for (const t of ["varchar", "nvarchar", "char", "nchar", "xml"]) {
      expect(nativeTypeInfo(t)).toEqual({ extractType: "text", castToText: false });
    }
    expect(nativeTypeInfo("time")).toEqual({ extractType: "text", castToText: true });
  });

  it("maps whole-number int types to number without casting", () => {
    for (const t of ["int", "smallint", "tinyint"]) {
      expect(nativeTypeInfo(t)).toEqual({ extractType: "number", castToText: false });
    }
  });

  it("maps exact-decimal/money/bigint types to number, casting to text", () => {
    for (const t of ["decimal", "numeric", "money", "smallmoney", "bigint"]) {
      expect(nativeTypeInfo(t)).toEqual({ extractType: "number", castToText: true });
    }
  });

  it("maps float/real to number without casting (inherently floating-point)", () => {
    for (const t of ["float", "real"]) {
      expect(nativeTypeInfo(t)).toEqual({ extractType: "number", castToText: false });
    }
  });

  it("maps date to date without casting", () => {
    expect(nativeTypeInfo("date")).toEqual({ extractType: "date", castToText: false });
  });

  it("maps every datetime-family type to datetime, casting to text", () => {
    for (const t of ["datetime", "smalldatetime", "datetime2", "datetimeoffset"]) {
      expect(nativeTypeInfo(t)).toEqual({ extractType: "datetime", castToText: true });
    }
  });

  it("excludes unsupported types with a reason", () => {
    for (const t of ["varbinary", "image", "geography", "geometry", "hierarchyid", "sql_variant"]) {
      const info = nativeTypeInfo(t);
      expect(info.extractType).toBeNull();
      expect(info.reason).toContain(t);
    }
  });

  it("excludes an unrecognized type with a reason rather than crashing", () => {
    const info = nativeTypeInfo("some_future_type");
    expect(info.extractType).toBeNull();
    expect(info.reason).toBeTruthy();
  });

  it("is case-insensitive", () => {
    expect(nativeTypeInfo("BIGINT").castToText).toBe(true);
  });
});
