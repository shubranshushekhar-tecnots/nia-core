import { describe, it, expect } from "vitest";
import type { TabularResult } from "@nia/schemas";
import { reduce, type SourceRows } from "./reduce.js";
import type { ReductionPlan } from "../../llm/prompts/reductionPlan.js";

function plan(overrides: Partial<Extract<ReductionPlan, { supported: true }>> = {}): Extract<ReductionPlan, { supported: true }> {
  return {
    supported: true,
    operation: "max",
    targetField: "salary",
    targetDescription: "the highest salary",
    ...overrides,
  };
}

function tabular(overrides: Partial<TabularResult> = {}): TabularResult {
  return {
    columns: [
      { name: "name", type: "string" },
      { name: "salary", type: "number" },
    ],
    rows: [],
    meta: {
      executedQuery: "SELECT name, salary FROM employees",
      connectionId: "00000000-0000-0000-0000-000000000001",
      durationMs: 5,
      rowCount: 0,
      truncated: false,
      ...overrides.meta,
    },
    ...overrides,
  };
}

function source(connectionId: string, rows: unknown[][], truncated = false): SourceRows {
  return {
    connectionId,
    result: tabular({ rows, meta: { rowCount: rows.length, truncated } as TabularResult["meta"] }),
  };
}

describe("reduce", () => {
  it("refuses when the plan is unsupported", () => {
    const outcome = reduce({ supported: false, reason: "asks for a list" }, []);
    expect(outcome).toEqual({ ok: false, reason: "asks for a list" });
  });

  it("refuses when there are no sources", () => {
    const outcome = reduce(plan(), []);
    expect(outcome.ok).toBe(false);
  });

  describe("max/min", () => {
    it("returns the single winner when there is no tie", () => {
      const sources = [
        source("a", [["Alice", 100]]),
        source("b", [["Bob", 200]]),
      ];
      const outcome = reduce(plan({ operation: "max" }), sources);
      expect(outcome.ok).toBe(true);
      if (outcome.ok && "winners" in outcome) {
        expect(outcome.value).toBe(200);
        expect(outcome.winners).toHaveLength(1);
        expect(outcome.winners[0]!.connectionId).toBe("b");
      } else {
        throw new Error("expected a max/min outcome with winners");
      }
    });

    it("returns ALL rows tying for the extreme, across sources — not a shape violation", () => {
      const sources = [
        source("a", [["Alice", 200]]),
        source("b", [["Bob", 200], ["Carl", 50]]),
      ];
      const outcome = reduce(plan({ operation: "max" }), sources);
      expect(outcome.ok).toBe(true);
      if (outcome.ok && "winners" in outcome) {
        expect(outcome.value).toBe(200);
        expect(outcome.winners).toHaveLength(2);
        expect(outcome.winners.map((w) => w.connectionId).sort()).toEqual(["a", "b"]);
      } else {
        throw new Error("expected a max/min outcome with winners");
      }
    });

    it("computes min correctly", () => {
      const sources = [source("a", [["Alice", 100]]), source("b", [["Bob", 20]])];
      const outcome = reduce(plan({ operation: "min" }), sources);
      expect(outcome.ok).toBe(true);
      if (outcome.ok && "winners" in outcome) {
        expect(outcome.value).toBe(20);
      } else {
        throw new Error("expected a max/min outcome with winners");
      }
    });

    it("refuses (never caveats) when any source is truncated", () => {
      const sources = [source("a", [["Alice", 100]], true), source("b", [["Bob", 200]])];
      const outcome = reduce(plan({ operation: "max" }), sources);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toMatch(/truncated/);
    });

    it("refuses when the target field is missing from a source", () => {
      const sources = [source("a", [["Alice", 100]])];
      const outcome = reduce(plan({ operation: "max", targetField: "bonus" }), sources);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toMatch(/no column/);
    });

    it("refuses when the target field is non-numeric", () => {
      const sources = [source("a", [["Alice", "lots"]])];
      const outcome = reduce(plan({ operation: "max" }), sources);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toMatch(/not numeric/);
    });

    it("refuses when no rows were returned by any source", () => {
      const sources = [source("a", []), source("b", [])];
      const outcome = reduce(plan({ operation: "max" }), sources);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toMatch(/No rows/);
    });
  });

  describe("sum/count", () => {
    function aggTabular(value: number, truncated = false, rowCount = 1): TabularResult {
      return tabular({
        columns: [{ name: "total", type: "number" }],
        rows: rowCount === 1 ? [[value]] : Array.from({ length: rowCount }, () => [value]),
        meta: { rowCount, truncated } as TabularResult["meta"],
      });
    }

    it("sums across sources", () => {
      const sources: SourceRows[] = [
        { connectionId: "a", result: aggTabular(10) },
        { connectionId: "b", result: aggTabular(25) },
      ];
      const outcome = reduce(plan({ operation: "sum", targetField: "total" }), sources);
      expect(outcome.ok).toBe(true);
      if (outcome.ok && "contributingSources" in outcome) {
        expect(outcome.value).toBe(35);
        expect(outcome.contributingSources).toEqual(["a", "b"]);
      } else {
        throw new Error("expected a sum/count outcome with contributingSources");
      }
    });

    it("counts across sources", () => {
      const sources: SourceRows[] = [
        { connectionId: "a", result: aggTabular(3) },
        { connectionId: "b", result: aggTabular(4) },
      ];
      const outcome = reduce(plan({ operation: "count", targetField: "total" }), sources);
      expect(outcome.ok).toBe(true);
      if (outcome.ok && "contributingSources" in outcome) {
        expect(outcome.value).toBe(7);
      } else {
        throw new Error("expected a sum/count outcome with contributingSources");
      }
    });

    it("refuses when a source's aggregate result is truncated", () => {
      const sources: SourceRows[] = [{ connectionId: "a", result: aggTabular(10, true) }];
      const outcome = reduce(plan({ operation: "sum", targetField: "total" }), sources);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toMatch(/truncated/);
    });

    it("refuses when a source returns more than one row for an aggregate — cannot distinguish from a truncated, badly-shaped query", () => {
      const sources: SourceRows[] = [{ connectionId: "a", result: aggTabular(10, false, 2) }];
      const outcome = reduce(plan({ operation: "sum", targetField: "total" }), sources);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toMatch(/expected exactly one aggregate row/);
    });

    it("refuses when the aggregate value is non-numeric", () => {
      const sources: SourceRows[] = [
        { connectionId: "a", result: tabular({ columns: [{ name: "total", type: "string" }], rows: [["nope"]], meta: { rowCount: 1 } as TabularResult["meta"] }) },
      ];
      const outcome = reduce(plan({ operation: "sum", targetField: "total" }), sources);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toMatch(/not numeric/);
    });

    it("extracts the real value (not the grouping artifact) from a Mongo-shaped {_id, value} aggregate row, even when the field name doesn't match plan.targetField", () => {
      // Regression case, caught live via chat-smoke.ts: queryGen.mongo.ts's
      // reductionHint always names the aggregate column "value" (never
      // plan.targetField) and, being a $group, always also emits "_id"
      // alongside it. A naive name-match-or-row[0] fallback would read
      // row[0] here, which is "_id" (null) — silently contributing 0
      // instead of the real value.
      const mongoShaped: SourceRows = {
        connectionId: "mongo-a",
        result: tabular({
          columns: [
            { name: "_id", type: "unknown" },
            { name: "value", type: "number" },
          ],
          rows: [[null, 3]],
          meta: { rowCount: 1 } as TabularResult["meta"],
        }),
      };
      const outcome = reduce(plan({ operation: "count", targetField: "id" }), [mongoShaped]);
      expect(outcome.ok).toBe(true);
      if (outcome.ok && "contributingSources" in outcome) {
        expect(outcome.value).toBe(3);
      } else {
        throw new Error("expected a sum/count outcome with contributingSources");
      }
    });

    it("refuses an aggregate row with more than one non-_id column as ambiguous, rather than guessing", () => {
      const ambiguous: SourceRows = {
        connectionId: "a",
        result: tabular({
          columns: [
            { name: "count_a", type: "number" },
            { name: "count_b", type: "number" },
          ],
          rows: [[3, 4]],
          meta: { rowCount: 1 } as TabularResult["meta"],
        }),
      };
      const outcome = reduce(plan({ operation: "count", targetField: "id" }), [ambiguous]);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toMatch(/ambiguous aggregate row shape/);
    });
  });
});
