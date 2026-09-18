import { describe, it, expect } from "vitest";
import { parseExpression } from "./expression.js";
import {
  SourceDestConfig,
  TransformConfig,
  FilterStep,
  ComputedFieldStep,
  DropFieldsStep,
  AggregateStep,
  parseNodeConfig,
} from "./nodeConfig.js";

describe("SourceDestConfig", () => {
  it("defaults operation to read", () => {
    expect(SourceDestConfig.parse({})).toEqual({ operation: "read" });
  });

  it("round-trips a write operation through JSON", () => {
    const parsed = SourceDestConfig.parse({ operation: "insert" });
    const roundTripped = SourceDestConfig.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });

  it("rejects an operation outside the manifest.ts Operation enum", () => {
    expect(() => SourceDestConfig.parse({ operation: "delete_everything" })).toThrow();
  });

  it("leaves entity undefined when absent (pre-Block-0 graphs)", () => {
    expect(SourceDestConfig.parse({})).toEqual({ operation: "read" });
    expect(SourceDestConfig.parse({}).entity).toBeUndefined();
  });

  it("round-trips a persisted entity ref through JSON", () => {
    const parsed = SourceDestConfig.parse({ operation: "read", entity: { namespace: "public", name: "users" } });
    const roundTripped = SourceDestConfig.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
    expect(roundTripped.entity).toEqual({ namespace: "public", name: "users" });
  });
});

describe("TransformConfig", () => {
  it("defaults to an empty step list", () => {
    expect(TransformConfig.parse({})).toEqual({ steps: [] });
  });

  it("round-trips a filter step (AND-composed conditions)", () => {
    const step: FilterStep = {
      kind: "filter",
      conditions: [
        { field: "status", operator: "eq", value: "active" },
        { field: "deleted_at", operator: "is_null" },
      ],
    };
    const parsed = TransformConfig.parse({ steps: [step] });
    const roundTripped = TransformConfig.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });

  it("round-trips a computed_field step carrying a parsed expression AST", () => {
    const exprResult = parseExpression("price * qty");
    expect(exprResult.ok).toBe(true);
    if (!exprResult.ok) return;
    const step: ComputedFieldStep = { kind: "computed_field", name: "line_total", expression: exprResult.expr };
    const parsed = TransformConfig.parse({ steps: [step] });
    const roundTripped = TransformConfig.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });

  it("round-trips a drop_fields step", () => {
    const step: DropFieldsStep = { kind: "drop_fields", fields: ["internal_notes", "raw_payload"] };
    const parsed = TransformConfig.parse({ steps: [step] });
    expect(parsed.steps[0]).toEqual(step);
  });

  it("round-trips an aggregate step with groupBy, aggregations, and having", () => {
    const step: AggregateStep = {
      kind: "aggregate",
      groupBy: ["cohort"],
      aggregations: [{ fn: "max", field: "salary", alias: "max_salary" }],
      having: [{ field: "max_salary", operator: "gt", value: 1000 }],
    };
    const parsed = TransformConfig.parse({ steps: [step] });
    const roundTripped = TransformConfig.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
    expect(parsed.steps[0]).toEqual(step);
  });

  it("defaults an aggregate step's groupBy/aggregations to [] (whole-table aggregate)", () => {
    const parsed = TransformConfig.parse({ steps: [{ kind: "aggregate" }] });
    expect(parsed.steps[0]).toEqual({ kind: "aggregate", groupBy: [], aggregations: [] });
  });

  it("allows field: null on an aggregate step's aggregation (count-star)", () => {
    const step: AggregateStep = { kind: "aggregate", groupBy: [], aggregations: [{ fn: "count", field: null, alias: "n" }] };
    const parsed = TransformConfig.parse({ steps: [step] });
    expect(parsed.steps[0]).toEqual(step);
  });

  it("rejects a step kind outside filter|computed_field|drop_fields|aggregate", () => {
    expect(() => TransformConfig.parse({ steps: [{ kind: "not_a_real_kind" }] })).toThrow();
  });
});

describe("parseNodeConfig", () => {
  it("parses an empty source config (Session 1 default) as recognized", () => {
    const result = parseNodeConfig("source", {});
    expect(result).toEqual({ unrecognized: false, type: "source", value: { operation: "read" } });
  });

  it("parses an empty transform config (Session 1 default) as recognized", () => {
    const result = parseNodeConfig("transform", {});
    expect(result).toEqual({ unrecognized: false, type: "transform", value: { steps: [] } });
  });

  it("flags a malformed transform config as unrecognized, preserving the raw value", () => {
    const raw = { steps: [{ kind: "not_a_real_step" }] };
    const result = parseNodeConfig("transform", raw);
    expect(result).toEqual({ unrecognized: true, type: "transform", raw });
  });

  it("flags an invalid operation value on a destination node as unrecognized, preserving the raw value", () => {
    const raw = { operation: "not_a_real_op" };
    const result = parseNodeConfig("destination", raw);
    expect(result).toEqual({ unrecognized: true, type: "destination", raw });
  });
});
