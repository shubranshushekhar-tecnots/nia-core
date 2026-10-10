import { Binary } from "mongodb";
import { describe, expect, it } from "vitest";
import { inferColumnType, serializeCellValue } from "./column-types.js";

describe("serializeCellValue (binary/blob columns)", () => {
  it("wraps a BSON Binary leaf as a base64 WireBinaryValue, not a bare string", () => {
    const bytes = Buffer.from([0, 1, 2, 255, 254, 72, 101, 108, 108, 111]);
    const value = serializeCellValue(new Binary(bytes));
    expect(value).toEqual({ __niaBytes: true, base64: bytes.toString("base64") });
  });

  it("still infers ColumnType \"binary\" for a Binary leaf (unaffected by the serialization fix)", () => {
    const bytes = Buffer.from([1, 2, 3]);
    expect(inferColumnType([new Binary(bytes)])).toBe("binary");
  });
});
