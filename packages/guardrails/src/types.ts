// Shared result/scope types used by every per-connector guardrail
// validator and by the registry (registry.ts) that dispatches to them.

import type { QueryPayload } from "@nia/schemas";
import type { ValidatedQuery } from "./validated.js";

/** Whatever the caller knows about the connection the query will run against. */
export type ConnectionScope = {
  connectionId: string;
  /** Collections/tables/schemas this connection is allowed to touch, if the caller wants scope enforcement. */
  allowedTargets?: string[];
};

/**
 * Internal shape returned by each per-connector validator (mysql.ts,
 * postgres.ts, mongodb.ts) — `sanitizedQuery` here is a plain QueryPayload,
 * not yet the opaque ValidatedQuery. Only registry.ts's
 * validateBeforeDispatch sees this shape; it wraps the ok branch into a
 * DispatchValidationResult before returning to any external caller.
 */
export type GuardrailResult =
  | { ok: true; sanitizedQuery: QueryPayload }
  | { ok: false; reason: string };

/** One validator per manifest id, registered in registry.ts. Each validator
 * is responsible for rejecting a QueryPayload whose `kind` doesn't match
 * the connector it's registered for. */
export type GuardrailValidator = (
  query: QueryPayload,
  scope: ConnectionScope,
) => GuardrailResult;

/**
 * The public result of validateBeforeDispatch — the only function in this
 * package allowed to mint a ValidatedQuery. This is the type any dispatch
 * function outside the package should require, so that dispatching an
 * unvalidated query is a compile error rather than a runtime check.
 */
export type DispatchValidationResult =
  | { ok: true; sanitizedQuery: ValidatedQuery }
  | { ok: false; reason: string };
