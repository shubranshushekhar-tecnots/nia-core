// Shared result/scope types used by every per-connector guardrail
// validator and by the registry (registry.ts) that dispatches to them.

import type { QueryPayload } from "@nia/schemas";

/** Whatever the caller knows about the connection the query will run against. */
export type ConnectionScope = {
  connectionId: string;
  /** Collections/tables/schemas this connection is allowed to touch, if the caller wants scope enforcement. */
  allowedTargets?: string[];
};

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
