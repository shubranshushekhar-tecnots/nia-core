import type { QueryPayload } from "@nia/schemas";

/**
 * Opaque proof that a QueryPayload has passed validateBeforeDispatch
 * (registry.ts) for a specific manifestId. The constructor is private, and
 * this class itself is never exported from the package (see index.ts,
 * which exports only the `ValidatedQuery` type below) — so no code outside
 * this module can name `ValidatedQueryImpl`, let alone construct one. The
 * only way to produce a value of this type is registry.ts's
 * validateBeforeDispatch; the only way a dispatch function can accept an
 * unvalidated query is if it's typed to take a plain QueryPayload instead
 * of this type, which is a deliberate, visible choice, not an oversight.
 *
 * Carries the manifestId it was validated against so a dispatch function
 * can assert the validated query is actually being sent to the connector
 * service it was validated for — a query validated for "mysql" must never
 * reach connector-mongodb, even if some caller mixes them up.
 */
export class ValidatedQueryImpl {
  private constructor(
    public readonly manifestId: string,
    public readonly query: QueryPayload,
  ) {}

  /**
   * Internal factory for registry.ts only. Not exported from the package —
   * reachable only by code inside @nia/guardrails itself.
   */
  static internalCreate(manifestId: string, query: QueryPayload): ValidatedQueryImpl {
    return new ValidatedQueryImpl(manifestId, query);
  }
}

/**
 * The public type. Callers outside this package can hold/pass/read a
 * ValidatedQuery, but can never construct one — `ValidatedQueryImpl` (the
 * only thing with a constructor for it) is not exported from the package.
 */
export type ValidatedQuery = ValidatedQueryImpl;
