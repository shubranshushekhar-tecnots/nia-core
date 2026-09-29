import { describe, it, expect } from "vitest";
import { parseExtraSchemas } from "./parseExtraSchemas.js";

describe("parseExtraSchemas", () => {
  it("splits comma-separated schema names and trims whitespace", () => {
    expect(parseExtraSchemas("analytics, reporting")).toEqual(["analytics", "reporting"]);
  });

  it("splits whitespace-separated schema names with no commas", () => {
    expect(parseExtraSchemas("analytics reporting")).toEqual(["analytics", "reporting"]);
  });

  it("drops empty entries from trailing/leading/doubled separators", () => {
    expect(parseExtraSchemas(" ,analytics,, reporting, ")).toEqual(["analytics", "reporting"]);
  });

  it("returns an empty array for blank input", () => {
    expect(parseExtraSchemas("")).toEqual([]);
    expect(parseExtraSchemas("   ")).toEqual([]);
  });

  it("returns a single-item array for one schema name", () => {
    expect(parseExtraSchemas("analytics")).toEqual(["analytics"]);
  });
});
