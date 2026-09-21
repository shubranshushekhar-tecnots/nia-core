import { describe, expect, it } from "vitest";
import {
  computeFailureReport,
  fallibleStepIsPushable,
  OnFailureAbortError,
  quarantineMessage,
  resolveOnFailure,
  rowFailed,
} from "./onFailure.js";
import { buildFailureExpr, parseExpression } from "../expression.js";

function expr(src: string) {
  const parsed = parseExpression(src);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.expr;
}

describe("resolveOnFailure", () => {
  it("absent onFailure resolves to 'fail'", () => {
    expect(resolveOnFailure(undefined)).toBe("fail");
  });

  it("an explicit policy passes through unchanged", () => {
    expect(resolveOnFailure("null")).toBe("null");
    expect(resolveOnFailure("drop")).toBe("drop");
    expect(resolveOnFailure("quarantine")).toBe("quarantine");
  });
});

describe("quarantine rejection", () => {
  const fallible = expr("to_number(amount)");
  const notFallible = expr("amount > 0");

  it("quarantineMessage rejects a step with onFailure: quarantine on a fallible expression", () => {
    const msg = quarantineMessage({ onFailure: "quarantine" }, fallible);
    expect(msg).toBe("quarantine requires a quarantine sink (Phase 11).");
  });

  it("quarantineMessage is null when the expression has no fallible call, even under quarantine", () => {
    expect(quarantineMessage({ onFailure: "quarantine" }, notFallible)).toBeNull();
  });

  it("quarantineMessage is null for any non-quarantine policy", () => {
    expect(quarantineMessage({ onFailure: "fail" }, fallible)).toBeNull();
    expect(quarantineMessage({}, fallible)).toBeNull();
  });

  it("computeFailureReport throws the same rejection unconditionally for quarantine", () => {
    expect(() => computeFailureReport("filter", fallible, [{ amount: "x" }], "quarantine")).toThrow(
      "quarantine requires a quarantine sink (Phase 11).",
    );
  });
});

describe("fallibleStepIsPushable", () => {
  const fallible = expr("to_number(amount)");
  const notFallible = expr("amount > 0");

  it("is true for 'fail' with a fallible expression (Phase 9 Part 4: pushed with a pre-check)", () => {
    expect(fallibleStepIsPushable({ onFailure: "fail" }, fallible)).toBe(true);
  });

  it("is true for absent onFailure with a fallible expression (defaults to 'fail', still pushable)", () => {
    expect(fallibleStepIsPushable({}, fallible)).toBe(true);
  });

  it("is false for 'quarantine' with a fallible expression", () => {
    expect(fallibleStepIsPushable({ onFailure: "quarantine" }, fallible)).toBe(false);
  });

  it("is true for 'null'/'drop' even with a fallible expression", () => {
    expect(fallibleStepIsPushable({ onFailure: "null" }, fallible)).toBe(true);
    expect(fallibleStepIsPushable({ onFailure: "drop" }, fallible)).toBe(true);
  });

  it("is true for any policy when the expression has no fallible call — onFailure has no effect", () => {
    expect(fallibleStepIsPushable({ onFailure: "fail" }, notFallible)).toBe(true);
    expect(fallibleStepIsPushable({ onFailure: "quarantine" }, notFallible)).toBe(true);
    expect(fallibleStepIsPushable({}, notFallible)).toBe(true);
  });
});

describe("computeFailureReport — 'null'/'drop' counts, no throw", () => {
  const fallible = expr("to_number(amount)");
  const rows = [{ amount: "10" }, { amount: "abc" }, { amount: null }];

  it("returns a report with the correct failing-row count for 'null'", () => {
    const report = computeFailureReport("filter", fallible, rows, "null");
    expect(report).toEqual({ label: "filter", fns: ["to_number"], policy: "null", count: 1 });
  });

  it("returns a report with the correct failing-row count for 'drop'", () => {
    const report = computeFailureReport("filter", fallible, rows, "drop");
    expect(report).toEqual({ label: "filter", fns: ["to_number"], policy: "drop", count: 1 });
  });

  it("returns undefined when the expression has no fallible call, regardless of policy", () => {
    const notFallible = expr("amount > 0");
    expect(computeFailureReport("filter", notFallible, rows, "fail")).toBeUndefined();
    expect(computeFailureReport("filter", notFallible, rows, "null")).toBeUndefined();
  });

  it("NULL input is not a failure — a row where the fallible call's argument is null doesn't count", () => {
    const onlyNullArg = [{ amount: null }];
    const report = computeFailureReport("filter", fallible, onlyNullArg, "null");
    expect(report).toEqual({ label: "filter", fns: ["to_number"], policy: "null", count: 0 });
  });
});

describe("computeFailureReport — 'fail' throws OnFailureAbortError with no raw values", () => {
  it("throws only when count > 0, naming the step/function/count, never the raw failing value", () => {
    const fallible = expr("to_number(amount)");
    const rows = [{ amount: "10" }, { amount: "super-secret-bad-value" }];
    try {
      computeFailureReport("filter", fallible, rows, "fail");
      throw new Error("expected computeFailureReport to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OnFailureAbortError);
      const message = (err as Error).message;
      expect(message).toBe("filter: to_number failed on 1 row(s).");
      expect(message).not.toContain("super-secret-bad-value");
    }
  });

  it("does not throw when every fallible call succeeds (count === 0)", () => {
    const fallible = expr("to_number(amount)");
    const rows = [{ amount: "10" }, { amount: "20" }];
    expect(computeFailureReport("filter", fallible, rows, "fail")).toEqual({
      label: "filter",
      fns: ["to_number"],
      policy: "fail",
      count: 0,
    });
  });
});

describe("handled-failure idioms (coalesce/is_null/is_not_null)", () => {
  const rows = [{ amount: "10" }, { amount: "abc" }, { amount: null }];

  it("coalesce(to_number(x), 0) is treated as handled — no failure report even under 'fail'", () => {
    const handled = expr("coalesce(to_number(amount), 0)");
    expect(computeFailureReport("computed_field", handled, rows, "fail")).toBeUndefined();
  });

  it("is_null(to_number(x)) is treated as handled — no failure report even under 'fail'", () => {
    const handled = expr("is_null(to_number(amount))");
    expect(computeFailureReport("filter", handled, rows, "fail")).toBeUndefined();
  });

  it("is_not_null(to_number(x)) is treated as handled — no failure report even under 'fail'", () => {
    const handled = expr("is_not_null(to_number(amount))");
    expect(computeFailureReport("filter", handled, rows, "fail")).toBeUndefined();
  });

  it("a handled fallible call is also pushable under 'fail' — nothing left to force residual", () => {
    const handled = expr("coalesce(to_number(amount), 0)");
    expect(fallibleStepIsPushable({ onFailure: "fail" }, handled)).toBe(true);
  });

  it("only DIRECT nesting counts as handled — a binary breaks adjacency, so the call still fails under 'fail'", () => {
    const notDirectlyHandled = expr("is_null(to_number(amount) + 1)");
    expect(() => computeFailureReport("filter", notDirectlyHandled, rows, "fail")).toThrow(OnFailureAbortError);
  });

  it("an unhandled fallible call alongside a handled one in the same expression is still reported", () => {
    // to_number(amount) is handled by coalesce; to_integer(amount) is not.
    const mixed = expr("coalesce(to_number(amount), 0) > 0 and to_integer(amount) > 0");
    const report = computeFailureReport("filter", mixed, rows, "null");
    expect(report).toEqual({ label: "filter", fns: ["to_integer"], policy: "null", count: 1 });
  });

  // Phase 9 follow-up: a coalesce only handles its nested fallible calls
  // when its LAST argument is non-fallible (guaranteed non-null fallback).
  // coalesce(to_number(x), 0)'s last argument is a literal, so it's still
  // handled (re-confirms the rule change didn't regress the common case,
  // already covered above). coalesce(parse_date(x, f1), parse_date(x, f2))'s
  // last argument is itself fallible, so the coalesce becomes ONE compound
  // fallible unit instead: it fails when a row's input is non-null but
  // matches neither format.
  it("coalesce(to_number(x), 0) — non-fallible last argument — stays handled", () => {
    const handled = expr("coalesce(to_number(amount), 0)");
    expect(computeFailureReport("computed_field", handled, rows, "fail")).toBeUndefined();
  });

  it("coalesce(parse_date(x, f1), parse_date(x, f2)) — fallible last argument — the coalesce itself is fallible and fails on a value matching neither format", () => {
    const bothFallible = expr('coalesce(parse_date(amount, "YYYY-MM-DD"), parse_date(amount, "MM/DD/YYYY"))');
    const dateRows = [
      { amount: "2024-01-15" }, // matches format 1 -> coalesce non-null, not a failure
      { amount: "01/15/2024" }, // matches format 2 -> coalesce non-null, not a failure
      { amount: "not-a-date" }, // matches neither -> coalesce null, input non-null -> failure
      { amount: null }, // null input -> not a failure (NULL input is never a failure)
    ];
    const report = computeFailureReport("computed_field", bothFallible, dateRows, "null");
    expect(report).toEqual({ label: "computed_field", fns: ["coalesce"], policy: "null", count: 1 });
  });
});

describe("rowFailed", () => {
  it("evaluates the failure predicate built by buildFailureExpr", () => {
    const failureExpr = buildFailureExpr(expr("to_number(amount)"))!;
    expect(rowFailed(failureExpr, { amount: "abc" })).toBe(true); // non-null arg, NULL result -> failure
    expect(rowFailed(failureExpr, { amount: "10" })).toBe(false); // valid -> not a failure
    expect(rowFailed(failureExpr, { amount: null })).toBe(false); // NULL arg -> not a failure
  });
});
