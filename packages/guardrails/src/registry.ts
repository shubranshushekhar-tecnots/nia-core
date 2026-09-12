import { CONNECTOR_MANIFESTS, type QueryPayload } from "@nia/schemas";
import { validateMongoPipeline } from "./mongodb.js";
import { validateMysqlQuery } from "./sql/mysql.js";
import { validatePostgresQuery } from "./sql/postgres.js";
import type { ConnectionScope, GuardrailResult, GuardrailValidator } from "./types.js";

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
};

/**
 * Single required call site for any code that dispatches a query to a
 * connector service (see the TODO markers in apps/worker/src/index.ts at
 * chat_query / check_run / etl_run — this function must run before any of
 * those actually send a query to a connector-service /execute endpoint).
 */
export function validateBeforeDispatch(
  manifestId: string,
  query: QueryPayload,
  connectionScope: ConnectionScope,
): GuardrailResult {
  const validator = GUARDRAIL_REGISTRY[manifestId];
  if (!validator) {
    return { ok: false, reason: `No guardrail validator registered for connector: ${manifestId}` };
  }
  return validator(query, connectionScope);
}
