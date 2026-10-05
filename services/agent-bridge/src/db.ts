import { createDbPool } from "@nia/db";

/**
 * The bridge never touches write-dispatch signing, and (unlike
 * services/connector-mysql's pool-manager.ts) has no per-connection
 * secret-backed pool — just one shared pool here. It does decrypt one
 * specific secret, a published setup's own destination vault_secret_ref,
 * for the owning agent only (Slice R3a, app.ts's
 * /agent-api/setups/:id/secret) — never any other connector's credential.
 */
export const dbPool = createDbPool({ connectionString: process.env.DATABASE_URL ?? "", max: 5 });

export async function checkDbReachable(): Promise<void> {
  try {
    await dbPool.query("select 1");
  } catch (err) {
    throw new Error(
      // Never interpolate the raw URL into a thrown/logged message — same
      // redaction discipline as services/connector-mysql/src/pool-manager.ts.
      `Cannot reach the database at DATABASE_URL (value redacted from logs): ${err instanceof Error ? err.message : String(err)}. ` +
        `If this service runs in Docker and DATABASE_URL points at 127.0.0.1/localhost, that address resolves to ` +
        `the container itself, not the host — use the database's internal Docker network name (or host.docker.internal) instead.`,
    );
  }
}
