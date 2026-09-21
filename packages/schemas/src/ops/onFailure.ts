import type { CallFn, Expr } from "../expression.js";
import { buildFailureExpr, collectFallibleCalls } from "../expression.js";
import type { OnFailurePolicy } from "../nodeConfig.js";
import { evalExpr } from "./residualEval.js";
import type { StepFailureReport } from "./types.js";

/**
 * Phase 8b-3 — shared onFailure plumbing used by filter.ts/computedField.ts/
 * aggregate.ts (SQL/Mongo emit + residual apply + checkConfig). Kept in one
 * place so the "absent = fail", "quarantine rejected at compile time", and
 * "every policy reports a count" rules can't drift between op modules.
 *
 * One load-bearing design decision lives here: "fail" and "quarantine" are
 * always forced residual (never pushed down) whenever a step's expression
 * actually contains a fallible call — see fallibleStepIsPushable below. A
 * pushed step can't observe a per-row failure count without a flag column
 * the worker sums, and that column would need to survive an aggregate's
 * setAggregate full-select-replacement when a preceding filter step is
 * fallible — materially harder than the value it buys, per Step 2's
 * documented escape hatch (docs/decisions.md's 8b-3 entry). "null" and
 * "drop" both still push normally: "null" is already today's behavior
 * (zero new code — a failing call is simply NULL), and "drop" either
 * collapses into existing NULL-is-not-TRUE semantics (filter, aggregate
 * having) or needs one extra WHERE-NOT/$match stage (computed_field only —
 * see computedField.ts). A documented v1 trade-off: a pushed "null"/"drop"
 * step doesn't get a failure COUNT (nothing walks every row); only a
 * residually executed step counts failures.
 */

/** "Absent" resolves to "fail" — see nodeConfig.ts's OnFailurePolicy doc comment for why this is the right default (no saved workflow uses computed_field yet, so there's no backward-compat "null" default to preserve). */
export function resolveOnFailure(policy: OnFailurePolicy | undefined): OnFailurePolicy {
  return policy ?? "fail";
}

export function exprHasFallibleCalls(expr: Expr): boolean {
  return collectFallibleCalls(expr).length > 0;
}

/** Distinct fallible fn names present in expr, for error/report messages ("names ... the function"). */
export function fallibleFnsIn(expr: Expr): CallFn[] {
  return [...new Set(collectFallibleCalls(expr).map((c) => c.fn))];
}

/**
 * "quarantine requires a quarantine sink (Phase 11)" — the sink itself
 * (Phase 11) doesn't exist yet, so quarantine is accepted by the schema but
 * always rejected once it would actually matter (i.e. the step has a
 * fallible call). checkConfig-facing: a plain message string (never
 * throws), so checkConfig's non-throwing contract stays intact.
 * computeFailureReport below throws the same rejection on the
 * emit/residual side, for a graph that was never re-checked after the
 * onFailure field was added by hand.
 */
export function quarantineMessage(step: { onFailure?: OnFailurePolicy }, expr: Expr): string | null {
  if (step.onFailure === "quarantine" && exprHasFallibleCalls(expr)) {
    return "quarantine requires a quarantine sink (Phase 11).";
  }
  return null;
}

/**
 * isPushable-facing: false whenever the resolved policy is "fail" or
 * "quarantine" AND the expression actually contains a fallible call — see
 * this file's top doc comment for why those two policies are always
 * residual. No effect (returns true) for "null"/"drop", or for any policy
 * on an expression with no fallible calls — the op's normal
 * exprFnsPushable check still governs pushability in every other case.
 */
export function fallibleStepIsPushable(step: { onFailure?: OnFailurePolicy }, expr: Expr): boolean {
  const policy = resolveOnFailure(step.onFailure);
  if ((policy === "fail" || policy === "quarantine") && exprHasFallibleCalls(expr)) {
    return false;
  }
  return true;
}

/** Thrown by computeFailureReport for policy "fail" once count > 0. runEtl.ts catches this and converts it into a clean run-abort — message names the step, the function(s), and the failing-row count only (no raw row values). */
export class OnFailureAbortError extends Error {
  constructor(label: string, fns: CallFn[], count: number) {
    super(`${label}: ${fns.join(", ")} failed on ${count} row(s).`);
    this.name = "OnFailureAbortError";
  }
}

/**
 * Residual (JS) row-failure test: true when `expr` contains a fallible call
 * whose own arguments are all non-null on this row but whose own result is
 * null. Delegates to the SAME `evalExpr` every other residual op uses via
 * the synthetic Expr `buildFailureExpr` builds (expression.ts) — no
 * separate per-function reimplementation here.
 */
export function rowFailed(failureExpr: Expr, row: Record<string, unknown>): boolean {
  return evalExpr(failureExpr, row) === true;
}

/**
 * Central residual-side helper shared by filter/computed_field/aggregate's
 * applyResidual. Returns undefined when `expr` has no fallible calls at all
 * (onFailure has no effect, nothing to report). Throws unconditionally for
 * "quarantine" (compile-time-style rejection — same message as
 * quarantineMessage) and for "fail" once `count > 0` (OnFailureAbortError).
 * Otherwise returns a StepFailureReport with the failing-row count over
 * `rows` as given — evaluated BEFORE any policy-driven row removal, so a
 * "drop"ped row is still counted, the exact shape residualTransform.ts
 * threads back to runEtl.ts for the run result.
 */
export function computeFailureReport(
  label: string,
  expr: Expr,
  rows: Record<string, unknown>[],
  policy: OnFailurePolicy,
): StepFailureReport | undefined {
  const fns = fallibleFnsIn(expr);
  if (fns.length === 0) return undefined;

  if (policy === "quarantine") {
    throw new Error("quarantine requires a quarantine sink (Phase 11).");
  }

  const failureExpr = buildFailureExpr(expr);
  const count = failureExpr ? rows.filter((row) => rowFailed(failureExpr, row)).length : 0;

  if (policy === "fail" && count > 0) {
    throw new OnFailureAbortError(label, fns, count);
  }

  return { label, fns, policy, count };
}

/** Builds the flag-column/field SQL-agnostic Expr once per emit call, or null when there's nothing fallible to track. Callers (computedField.ts's emitSql/emitMongo, computeFailureReport) all funnel through this so "which calls are fallible" can never drift between them. */
export { buildFailureExpr };
