import { describe, expect, it } from "vitest";
import { computeColumnStats } from "../profile/stats.js";
import { routeColumn } from "./router.js";

/**
 * Phase 13, Step 3 — one test per routing rule, including the
 * identifier-like skip. Fixtures are built via the real Phase 10
 * computeColumnStats (not hand-crafted ColumnStats objects) so the
 * router is exercised against realistic parseRates/failingExamples
 * shapes, the same way it will be called in production.
 */
describe("routeColumn", () => {
  it("routes to missing-value when missing-value tokens are present and there's no coercion signal", () => {
    const stats = computeColumnStats("notes", "text", ["alpha", "beta", "N/A", "gamma"]);
    const route = routeColumn(stats);
    expect(route.route).toBe("missing-value");
  });

  it("does not route to missing-value when there is no missing-value signal", () => {
    const stats = computeColumnStats("score", "int", [1, 2, 3, 4]);
    const route = routeColumn(stats);
    expect(route.route).toBe("none");
  });

  it("routes to coercion via a positive parse rate", () => {
    const stats = computeColumnStats("qty", "varchar", ["10", "20", "30", "40"]);
    const route = routeColumn(stats);
    expect(route.route).toBe("coercion");
  });

  it("routes to coercion via suspicious failing examples (currency symbol) even when parse rate is 0", () => {
    const stats = computeColumnStats("amount", "varchar", ["$10.00", "$25.50", "$3.75"]);
    expect(stats.parseRates!.to_number!.passed).toBe(0);
    const route = routeColumn(stats);
    expect(route.route).toBe("coercion");
  });

  it("does not route to coercion when there is no numeric/date/boolean signal at all", () => {
    const stats = computeColumnStats("color", "varchar", ["red", "blue", "green"]);
    const route = routeColumn(stats);
    expect(route.route).toBe("none");
  });

  it("routes to both when a column has missing-value tokens and a coercion signal", () => {
    const stats = computeColumnStats("qty", "varchar", ["10", "20", "N/A", "30"]);
    const route = routeColumn(stats);
    expect(route.route).toBe("both");
  });

  it("routes to none when neither rule triggers", () => {
    const stats = computeColumnStats("label", "varchar", ["north", "south", "east"]);
    const route = routeColumn(stats);
    expect(route.route).toBe("none");
  });

  it("skips coercion on an identifier-like column via name match (zip_code), even with a positive parse rate", () => {
    const stats = computeColumnStats("zip_code", "varchar", ["12345", "67890", "54321"]);
    expect(stats.parseRates!.to_number!.passed).toBe(3);
    const route = routeColumn(stats);
    expect(route.route).toBe("none");
    expect(route.reason).toContain("identifier-like, skipped");
  });

  it("skips coercion on an identifier-like column via leading-zero values, even when the name doesn't match", () => {
    const stats = computeColumnStats("district", "varchar", ["00501", "00210", "00601"]);
    expect(stats.hasLeadingZeroStrings).toBe(true);
    const route = routeColumn(stats);
    expect(route.route).toBe("none");
    expect(route.reason).toContain("identifier-like, skipped");
  });

  it("still routes to missing-value on an identifier-like column that also has missing values, instead of none", () => {
    const stats = computeColumnStats("district", "varchar", ["00501", "00210", "N/A", "00601"]);
    const route = routeColumn(stats);
    expect(route.route).toBe("missing-value");
    expect(route.reason).toContain("identifier-like, skipped");
  });
});
