import type { CallFn, Expr } from "../expression.js";
import { buildFailureExpr, collectFallibleCalls, collectFallibleCallsDeep } from "../expression.js";
import type { OnFailurePolicy } from "../nodeConfig.js";
import { evalExpr } from "./residualEval.js";
import type { QuarantinedRow, StepFailureReport } from "./types.js";

/**
 * Phase 8b-3 — shared onFailure plumbing used by filter.ts/computedField.ts/
 * aggregate.ts (SQL/Mongo emit + residual apply + checkConfig). Kept in one
 * place so the "absent = fail", "every policy reports a count" rules can't
 * drift between op modules.
 *
 * One load-bearing design decision lives here: "quarantine" is always
 * forced residual (never pushed down) whenever a step's expression actually
 * contains a fallible call — see fallibleStepIsPushable below. Only
 * residual execution has the full source row available to hand to the
 * quarantine sink (Phase 11); there's nothing to gain by pushing a step
 * that would need the source row it doesn't have.
 * "fail" DOES push now (Phase 9 Part 4): pushdown.ts's
 * compileFailurePreChecks runs one pre-check query, before extraction,
 * reusing the exact same upstream-pushed prefix, and runEtl.ts aborts
 * before any write if it finds failing rows — so a pushed "fail" step gets
 * the same "abort before any write, with an exact count" guarantee the
 * residual path always had, without needing a flag column. "null" and
 * "drop" both still push normally: "null" is already today's behavior
 * (zero new code — a failing call is simply NULL), and "drop" either
 * collapses into existing NULL-is-not-TRUE semantics (filter, aggregate
 * having) or needs one extra WHERE-NOT/$match stage (computed_field only —
 * see computedField.ts). Their failure COUNT also now comes from the same
 * pre-check mechanism (a COUNT(*) query) instead of requiring residual
 * execution — see compileFailurePreChecks's doc comment in pushdown.ts.
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
 * isPushable-facing: false only when the resolved policy is "quarantine"
 * AND the expression actually contains a fallible call — see this file's
 * top doc comment for why quarantine is always residual. "fail" (Phase 9
 * Part 4), "null", and "drop" all return true here — the op's normal
 * exprFnsPushable check still governs pushability in every other case.
 */
export function fallibleStepIsPushable(step: { onFailure?: OnFailurePolicy }, expr: Expr): boolean {
  const policy = resolveOnFailure(step.onFailure);
  if (policy === "quarantine" && exprHasFallibleCalls(expr)) {
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
 * Per-row attribution (Phase 11 quarantine sink): given a row already known
 * to have failed (rowFailed/buildFailureExpr returned true for it), finds
 * the SPECIFIC fallible call responsible — the first call in
 * collectFallibleCalls(expr) whose own args all evaluate non-null on this
 * row but whose own result evaluates null — and returns its fn name plus
 * its first argument's evaluated value (the natural "input that caused the
 * failure" to persist to the quarantine table's `function`/`input_value`
 * columns). A `coalesce` compound unit (see collectFallibleCalls's
 * `coalesce` branch) is expanded via collectFallibleCallsDeep so the
 * specific nested call is attributed, not the coalesce call node itself.
 * Returns null only if called on a row that didn't actually fail (callers
 * only call this after rowFailed has already confirmed a match).
 */
export function findFailingCall(expr: Expr, row: Record<string, unknown>): { fn: CallFn; inputValue: unknown } | null {
  const topLevel = collectFallibleCalls(expr);
  for (const call of topLevel) {
    const candidates = call.fn === "coalesce" ? collectFallibleCallsDeep(call) : [call];
    for (const candidate of candidates) {
      const argsNonNull = candidate.args.every((arg) => evalExpr(arg, row) !== null);
      if (!argsNonNull) continue;
      if (evalExpr(candidate, row) !== null) continue;
      const inputValue = candidate.args.length > 0 ? evalExpr(candidate.args[0]!, row) : null;
      return { fn: candidate.fn, inputValue };
    }
  }
  return null;
}

/**
 * Central residual-side helper shared by filter/computed_field/aggregate's
 * applyResidual. Returns undefined when `expr` has no fallible calls at all
 * (onFailure has no effect, nothing to report). Throws for "fail" once
 * `count > 0` (OnFailureAbortError). For "quarantine", never throws —
 * instead attaches a `quarantinedRows` entry (via findFailingCall) for
 * every failing row, letting runEtl.ts (Phase 11) route them to the
 * quarantine sink. Otherwise returns a StepFailureReport with the
 * failing-row count over `rows` as given — evaluated BEFORE any
 * policy-driven row removal, so a "drop"ped/quarantined row is still
 * counted, the exact shape residualTransform.ts threads back to runEtl.ts
 * for the run result.
 */
export function computeFailureReport(
  label: string,
  expr: Expr,
  rows: Record<string, unknown>[],
  policy: OnFailurePolicy,
): StepFailureReport | undefined {
  const fns = fallibleFnsIn(expr);
  if (fns.length === 0) return undefined;

  const failureExpr = buildFailureExpr(expr);
  const failingRows = failureExpr ? rows.filter((row) => rowFailed(failureExpr, row)) : [];
  const count = failingRows.length;

  if (policy === "fail" && count > 0) {
    throw new OnFailureAbortError(label, fns, count);
  }

  if (policy === "quarantine" && count > 0) {
    const quarantinedRows: QuarantinedRow[] = failingRows.map((row) => {
      const failing = findFailingCall(expr, row);
      return { fn: failing?.fn ?? fns[0]!, inputValue: failing?.inputValue ?? null, sourceRow: row };
    });
    return { label, fns, policy, count, quarantinedRows };
  }

  return { label, fns, policy, count };
}

/** Builds the flag-column/field SQL-agnostic Expr once per emit call, or null when there's nothing fallible to track. Callers (computedField.ts's emitSql/emitMongo, computeFailureReport) all funnel through this so "which calls are fallible" can never drift between them. */
export { buildFailureExpr };
