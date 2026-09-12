import { describe, expect, it } from "vitest";
import { mapPostgresColumnType } from "./column-types.js";

describe("mapPostgresColumnType", () => {
  it("maps common scalar OIDs to the correct ColumnType", () => {
    expect(mapPostgresColumnType(16)).toBe("boolean"); // bool
    expect(mapPostgresColumnType(20)).toBe("number"); // int8
    expect(mapPostgresColumnType(23)).toBe("number"); // int4
    expect(mapPostgresColumnType(25)).toBe("string"); // text
    expect(mapPostgresColumnType(1043)).toBe("string"); // varchar
    expect(mapPostgresColumnType(1082)).toBe("date"); // date
    expect(mapPostgresColumnType(1114)).toBe("date"); // timestamp
    expect(mapPostgresColumnType(1184)).toBe("date"); // timestamptz
    expect(mapPostgresColumnType(1700)).toBe("number"); // numeric
    expect(mapPostgresColumnType(2950)).toBe("string"); // uuid
    expect(mapPostgresColumnType(3802)).toBe("json"); // jsonb
    expect(mapPostgresColumnType(17)).toBe("binary"); // bytea
  });

  it("maps array OIDs to json", () => {
    expect(mapPostgresColumnType(1009)).toBe("json"); // _text
    expect(mapPostgresColumnType(1007)).toBe("json"); // _int4
    expect(mapPostgresColumnType(3807)).toBe("json"); // _jsonb
  });

  it("falls back to unknown for unmapped/exotic OIDs, not a wrong guess", () => {
    expect(mapPostgresColumnType(790)).toBe("unknown"); // money
    expect(mapPostgresColumnType(869)).toBe("unknown"); // inet
    expect(mapPostgresColumnType(999999)).toBe("unknown"); // made up, doesn't exist
  });
});
