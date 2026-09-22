import { CONNECTOR_MANIFESTS, type QueryPayload } from "@nia/schemas";
import { validateMongoPipeline } from "./mongodb.js";
import { validateMysqlQuery } from "./sql/mysql.js";
import { validatePostgresQuery } from "./sql/postgres.js";
import type { ConnectionScope, DispatchValidationResult, GuardrailValidator } from "./types.js";
import { ValidatedQueryImpl } from "./validated.js";

/**
 * One validator per manifest id. Every manifest with the `queryable`
 * capability MUST have an entry here — enforced by registry.test.ts's
 * completeness check, which fails the build if a new queryable connector
 * is added without one.
 */
export const GUARDRAIL_REGISTRY: Record<string, GuardrailValidator> = {
  mysql: validateMysqlQuery,
  mongodb: validateMongoPipeline,
  supabase: validatePostgresQuery,
  postgres: validatePostgresQuery,
};

/**
 * Single required call site for any code that dispatches a query to a
 * connector service (see apps/worker/src/lib/dispatch.ts — this function
 * must run before any query reaches a connector-service /execute
 * endpoint). This is also the only place in the package allowed to mint a
 * ValidatedQuery (validated.ts) — a caller cannot get one any other way,
 * which is what makes dispatching an unvalidated query a compile error at
 * the dispatch function's boundary rather than a convention.
 */
export function validateBeforeDispatch(
  manifestId: string,
  query: QueryPayload,
  connectionScope: ConnectionScope,
): DispatchValidationResult {
  const validator = GUARDRAIL_REGISTRY[manifestId];
  if (!validator) {
    return { ok: false, reason: `No guardrail validator registered for connector: ${manifestId}` };
  }
  const result = validator(query, connectionScope);
  if (!result.ok) return result;
  return { ok: true, sanitizedQuery: ValidatedQueryImpl.internalCreate(manifestId, result.sanitizedQuery) };
}
