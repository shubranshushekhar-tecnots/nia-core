import { createDbPool } from "@nia/db";

/**
 * The bridge never touches connector secrets or write-dispatch signing —
 * it only reads/writes platform_agents/agent_pairing_codes via
 * withServiceRole, so (unlike services/connector-mysql's pool-manager.ts)
 * there is no per-connection secret-backed pool here, just one shared pool.
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
