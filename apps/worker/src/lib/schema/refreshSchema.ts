import type { IntrospectResponse, SchemaRefreshJob } from "@nia/schemas";
import { resolveConnection } from "../resolveConnection.js";
import { getSchema, invalidateSchema } from "../introspection.js";

/**
 * Phase 5 Session 5, Block 2 — worker-side half of schema refresh. Busts
 * this connection's entry in the worker's OWN introspection cache
 * (lib/introspection.ts) and re-fetches, so the next check_run job (which
 * always executes worker-side — see checks/runWorkflowChecks.ts's
 * buildMappingsCheck, which calls this same lib/introspection.ts) sees
 * live data instead of a pre-drift schema.
 *
 * This is a SEPARATE cache from apps/api/src/lib/schemaCache.ts (different
 * process, no shared memory): apps/api's refreshConnectionSchema() busts
 * its own cache directly and enqueues this job to bust the worker's, so a
 * single "Refresh schema" click clears both halves. Without this job, a
 * click on that button would only fix the drawer's field pickers (served
 * by apps/api) while "Run checks" (served by apps/worker) kept reporting
 * the stale, pre-drift schema as passing — silently defeating the whole
 * point of the affordance.
 */
export async function refreshSchema(job: SchemaRefreshJob): Promise<IntrospectResponse> {
  const resolved = await resolveConnection(job.connectionId, job.scope);
  if (!resolved.ok) {
    throw new Error(resolved.error.message);
  }
  invalidateSchema(resolved.value);
  const result = await getSchema(resolved.value);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}
