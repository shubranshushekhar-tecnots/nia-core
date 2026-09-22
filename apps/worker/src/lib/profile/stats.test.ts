import { describe, expect, it } from "vitest";
import { computeColumnStats } from "./stats.js";

/**
 * Phase 10 Step 4 test 1 — stats on one fixed in-memory sample. Not
 * exhaustive over every ColumnStats field; just enough to pin the
 * null/empty/whitespace/missing-token/distinct counts and the text-column
 * parse-rate gating (computeParseRate itself is exercised indirectly via
 * evalExpr, already covered by that module's own tests).
 */
describe("computeColumnStats", () => {
  it("counts null/empty/whitespace/missing-token/distinct on a text column", () => {
    const values = ["42", "", "  ", "N/A", null, "42", "7"];
    const stats = computeColumnStats("qty", "varchar", values);

    expect(stats.sampleCount).toBe(7);
    expect(stats.nullCount).toBe(1);
    expect(stats.emptyStringCount).toBe(1);
    expect(stats.whitespaceOnlyCount).toBe(1);
    expect(stats.missingTokenCount).toBe(1);
    // distinct counts every observed value (including null and dupes) as its own JSON key
    expect(stats.distinctCount).toBe(6);
    expect(stats.isTextColumn).toBe(true);
    expect(stats.observedTypes).toEqual(["null", "string"]);
  });

  it("computes text parse rates for a numeric-looking column, with failing examples for non-numeric rows", () => {
    const values = ["1", "2", "not-a-number"];
    const stats = computeColumnStats("amount", "varchar", values);

    expect(stats.isTextColumn).toBe(true);
    expect(stats.parseRates).not.toBeNull();
    const toNumber = stats.parseRates!.to_number!;
    expect(toNumber.attempted).toBe(3);
    expect(toNumber.passed).toBe(2);
    expect(toNumber.failingExamples).toEqual(["not-a-number"]);
  });

  it("computes min/max for a numeric column and leaves parseRates null", () => {
    const stats = computeColumnStats("price", "numeric", [3, 1, 2]);

    expect(stats.isTextColumn).toBe(false);
    expect(stats.parseRates).toBeNull();
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(3);
  });

  it("computes min/max length for a text column", () => {
    const stats = computeColumnStats("name", "varchar", ["ab", "abcdef", "abcd"]);
    expect(stats.minLength).toBe(2);
    expect(stats.maxLength).toBe(6);
  });

  it("flags leading-zero numeric strings, which pass to_number and so leave no failing example", () => {
    const withLeadingZero = computeColumnStats("zip", "varchar", ["00501", "10001", "90210"]);
    expect(withLeadingZero.hasLeadingZeroStrings).toBe(true);
    expect(withLeadingZero.parseRates!.to_number!.passed).toBe(3);
    expect(withLeadingZero.parseRates!.to_number!.failingExamples).toEqual([]);

    const withoutLeadingZero = computeColumnStats("qty", "varchar", ["1", "0", "0.5", "42"]);
    expect(withoutLeadingZero.hasLeadingZeroStrings).toBe(false);
  });
});
