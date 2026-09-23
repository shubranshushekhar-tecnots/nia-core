import type { QueryPayload } from "@nia/schemas";
import { ValidatedQueryImpl, type ValidatedQuery } from "./validated.js";

/**
 * Compile-time-only proof that ValidatedQuery cannot be forged.
 *
 * Named `*.test-d.ts` (not `*.test.ts`) deliberately: every package's
 * tsconfig.json excludes `src/**\/*.test.ts` from `tsc --noEmit` (vitest
 * type-strips those, it never type-checks them), so a `@ts-expect-error`
 * inside a `*.test.ts` file here would prove nothing — `pnpm typecheck`
 * would never see it. This file IS included in the normal build/typecheck,
 * so `pnpm --filter @nia/guardrails typecheck` (and the root `turbo
 * typecheck`) genuinely fails if either assertion below stops being a type
 * error. Nothing here is ever imported or executed at runtime.
 */

const rawQuery: QueryPayload = { kind: "sql", sql: "select 1", params: [] };

// 1. ValidatedQueryImpl's constructor is private — even code that can
// import the class directly (this file, inside the same package) cannot
// construct one. The only way in is the static internalCreate factory,
// called exclusively from registry.ts's validateBeforeDispatch.
function _typeOnly_privateConstructorRejected(): ValidatedQueryImpl {
  // @ts-expect-error - constructor is private; only ValidatedQueryImpl.internalCreate may construct one.
  return new ValidatedQueryImpl("mysql", rawQuery);
}

// 2. A plain QueryPayload object literal can never satisfy the
// ValidatedQuery type — proving that any function typed to accept
// `ValidatedQuery` (e.g. the worker's connector-dispatch call) rejects an
// unvalidated query at compile time, not via a runtime check.
function _typeOnly_acceptsOnlyValidatedQuery(_q: ValidatedQuery): void {}
// @ts-expect-error - a raw QueryPayload does not satisfy ValidatedQuery.
_typeOnly_acceptsOnlyValidatedQuery(rawQuery);
