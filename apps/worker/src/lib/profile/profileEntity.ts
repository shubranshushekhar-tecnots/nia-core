import { findPersistedEntity, manifestDialect, type EntityProfile, type ProfileRunJob } from "@nia/schemas";
import { resolveConnection } from "../resolveConnection.js";
import { getSchema } from "../introspection.js";
import { sampleEntity } from "./sampleEntity.js";
import { computeColumnStats } from "./stats.js";
import { computeSignature, computeProfileHash } from "./signature.js";

/**
 * Phase 10 Step 3 — the ProfileRunJob orchestrator. Same no-persistence-in-
 * worker shape as every other interactive job handler (refreshSchema.ts,
 * runPreview.ts): resolves the connection, resolves the entity against the
 * live schema, samples it, computes stats/signature/hash, and returns the
 * result — apps/api's profile service is the one that upserts it into
 * source_profiles, through its own req.supabase with the caller's real JWT
 * (this worker only ever holds a service_role client — see index.ts's
 * header comment for why persistence never happens here).
 *
 * Throws on any failure (mirrors refreshSchema.ts, not runPreview.ts/
 * proposeMapping.ts's ok/error result shape) — this job has no interesting
 * partial-failure states worth distinguishing to the caller beyond "it
 * didn't work," and apps/api's profileQueue.ts (mirroring
 * schemaRefreshQueue.ts) already turns a rejected waitUntilFinished into a
 * 503 AppError uniformly for every job of this shape.
 */
export async function profileEntity(job: ProfileRunJob): Promise<EntityProfile> {
  const resolved = await resolveConnection(job.connectionId, job.scope);
  if (!resolved.ok) {
    throw new Error(resolved.error.message);
  }
  const connection = resolved.value;

  const schemaResult = await getSchema(connection);
  if (!schemaResult.ok) {
    throw new Error(schemaResult.error.message);
  }
  const schema = schemaResult.value;

  const entity = findPersistedEntity(schema, job.entity);
  if (!entity) {
    throw new Error(`Entity ${job.entity.namespace}.${job.entity.name} not found in the connection's current schema.`);
  }

  const dialect = manifestDialect(connection.connectorId);
  if (!dialect) {
    throw new Error(`Connector "${connection.connectorId}" has no supported query dialect.`);
  }

  const sample = await sampleEntity(
    dialect,
    { namespace: entity.namespace, name: entity.name },
    entity.primaryKey,
    job.connectionId,
    job.scope,
    job.triggeredByUserId,
  );
  if (!sample.ok) {
    throw new Error(sample.error.message);
  }

  const declaredTypes = new Map(entity.fields.map((f) => [f.name, f.type]));
  const columns = sample.value.columns.map((name) => {
    const values = sample.value.rows.map((row) => row[name]);
    return computeColumnStats(name, declaredTypes.get(name) ?? "unknown", values);
  });

  const signature = computeSignature(columns);
  const profileHash = computeProfileHash(signature);

  return {
    sampleMethod: sample.value.sampleMethod,
    sampleSize: sample.value.rows.length,
    columns,
    signature,
    profileHash,
    profiledAt: new Date().toISOString(),
  };
}
