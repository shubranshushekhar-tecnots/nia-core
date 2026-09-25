import pg from "pg";
import { createDbPool, withServiceRole } from "@nia/db";
import { createEnvKeySecretStore } from "@nia/secrets";
import type { ConnectorConfig, CredentialRef } from "@nia/schemas";

// Phase 8b-2, Fix 1 finding — node-postgres deliberately does NOT parse
// NUMERIC/DECIMAL (OID 1700) to a JS number by default (unlike
// DOUBLE PRECISION/OID 701, which it does parse), to avoid silent precision
// loss for callers who need exact decimal semantics. But column-types.ts's
// OID_TO_COLUMN_TYPE already declares OID 1700 -> ColumnType "number" — so
// without this, any genuine customer `numeric`/`decimal` column (not just
// pushdown's own CAST(... AS numeric), which sqlShared.ts's
// castAmbiguousLiteral switched to from `double precision` specifically to
// fix a bigint float64-collision false positive) would silently return
// string values through a contract that already promises "number".
// Registering this once, at module load (pg's type parser registry is
// process-global), aligns runtime values with that pre-existing declared
// contract. parseFloat, not a bigint-safe parser: OID 20 (int8/bigint) is a
// separate OID, untouched here, and keeps its own existing string-return
// behavior (see docs/decisions.md's Fix 1 entry for why bigint precision is
// handled differently — an actual bigint value can exceed
// Number.MAX_SAFE_INTEGER, which decimal-shaped numeric values from this
// cast never do).
pg.types.setTypeParser(1700, (val: string) => parseFloat(val));

/**
 * Pool manager — warm connections keyed by `connectionId:credVersion`.
 * Lazy-created, idle-evicted, socket-capped so Nia never exhausts a
 * customer's small database tier. Credential rotation bumps credVersion,
 * so stale pools simply stop being hit and age out.
 *
 * A pool is composed from two sources: `config` (host/port/database/ssl —
 * sent by Express on every dispatch call, since it lives in Postgres
 * directly) and the nia_secrets secret (user/password — resolved here,
 * inside the service, and never sent by or back to Express).
 *
 * Mirrors connector-mysql's pool-manager, including the in-flight-promise
 * cache fix from the start (not bolted on after): pools maps key ->
 * Promise<Pool>, written synchronously before any await, with a rejection
 * handler that deletes the key so a failed resolve doesn't poison the cache.
 */

const POOL_LIMIT_PER_CONNECTION = 3;
const IDLE_EVICT_MS = 5 * 60 * 1000;

type Entry = { poolPromise: Promise<pg.Pool>; lastUsed: number };
const pools = new Map<string, Entry>();

// Item 4.1 fix (fix-chain plan): TLS used to default OFF (`config.ssl === true`)
// — safe for the mysql/mongo-style dev-container pattern this was copied from,
// but wrong for Postgres-family targets, where a real hosted instance
// (Supabase, Neon, ...) both supports and typically requires TLS, and a
// silent plaintext fallback on a typo'd/missing `ssl` field is a real data-
// exposure risk. Flip the default to ON, but keep local/sandbox hosts
// (docker-compose dev DBs, localhost) defaulting to OFF so the existing dev
// workflow (docker/dev-postgres-init.sql, plaintext by design) keeps working
// without every developer needing to know to untick a box. Item 4A: hosts
// matching a known managed-Postgres provider force TLS on regardless of the
// stored `ssl` value — reproducing a real deployment "TLS off but pointed at
// Neon/Supabase" typo should not be honored as silently-broken plaintext.
//
// Sandbox detection also treats any bare (dot-less) hostname as local/sandbox
// — this is how docker-compose service-name hosts look (e.g. this repo's own
// `dev-postgres`, see docker-compose.yml/dispatch-smoke.ts), and no real
// public DNS name is ever a single label. Without this, the existing
// plaintext docker-compose sandbox flow would silently start requesting TLS
// against a container that never speaks it.
const SANDBOX_HOST_PATTERN = /^(localhost|127\.0\.0\.1|host\.docker\.internal)$|\.internal$/i;
const FORCED_TLS_HOST_PATTERN = /(\.|^)(neon\.tech|supabase\.co|pooler\.supabase\.com)$/i;

function resolveSsl(host: string, explicit: unknown): boolean {
  if (FORCED_TLS_HOST_PATTERN.test(host)) return true;
  if (explicit === true) return true;
  if (explicit === false) return false;
  const isSandboxHost = SANDBOX_HOST_PATTERN.test(host) || !host.includes(".");
  return !isSandboxHost;
}

function parsePostgresConfig(
  config: ConnectorConfig,
): { host: string; port: number; database: string; ssl: boolean } {
  const host = config.host;
  const port = Number(config.port);
  const database = config.database;
  if (typeof host !== "string" || !host) throw new Error("config.host must be a non-empty string");
  if (!Number.isInteger(port) || port <= 0) throw new Error("config.port must be a positive integer");
  if (typeof database !== "string" || !database) throw new Error("config.database must be a non-empty string");
  const ssl = resolveSsl(host, config.ssl);
  return { host, port, database, ssl };
}

// App-database pool, used via withServiceRole for: reading nia_secrets
// directly (service_role bypasses its RLS, granted select in
// 0032_nia_secrets.sql) and write_grants lookups. Never touches any other
// table. Vault's resolve_connector_secret RPC (legacy fallback) was
// dropped once every live ref was confirmed backfilled into nia_secrets —
// see docs/decisions.md's Vault-removal entry. Deliberately a separate
// pool from the customer-target pools this file otherwise manages (below,
// keyed by connectionId) — this one talks to Nia's own app database, not
// a customer's.
const dbPool = createDbPool({ connectionString: process.env.DATABASE_URL ?? "", max: 5 });

// docs/plans/secret-storage.md — nia_secrets (envelope-encrypted under
// NIA_SECRET_MASTER_KEY). Mirrors connector-mysql/src/pool-manager.ts's
// wiring exactly.
const secretStore = createEnvKeySecretStore({
  pool: dbPool,
  masterKey: process.env.NIA_SECRET_MASTER_KEY ?? "",
});

async function resolveSecret(secretRef: string): Promise<{ user: string; password: string }> {
  // Resolved here, inside the service — the decrypted value never crosses
  // back over the Express -> service boundary, and Express never sees it:
  // it only ever forwards the opaque secretRef.
  const data = await secretStore.get(secretRef);
  if (
    typeof data !== "object" ||
    data === null ||
    typeof (data as Record<string, unknown>).user !== "string" ||
    typeof (data as Record<string, unknown>).password !== "string"
  ) {
    throw new Error(`secret ${secretRef} is missing user/password`);
  }
  return { user: (data as { user: string }).user, password: (data as { password: string }).password };
}

function createPool(key: string, cred: CredentialRef, config: ConnectorConfig): Promise<pg.Pool> {
  const existing = pools.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.poolPromise;
  }

  // Build the promise and write it to the cache before any await runs —
  // that's what closes the race: every concurrent caller sees this same
  // Entry, not just the one that happens to finish resolveSecret last.
  const poolPromise = (async () => {
    const { host, port, database, ssl } = parsePostgresConfig(config);
    const secret = await resolveSecret(cred.vaultRef);
    const pool = new pg.Pool({
      host,
      port,
      database,
      user: secret.user,
      password: secret.password,
      max: POOL_LIMIT_PER_CONNECTION,
      ssl: ssl ? { rejectUnauthorized: false } : undefined,
    });
    // Phase 8b-2, batch 5 — pin every physical connection's session
    // timezone to UTC. EXTRACT(part FROM a timestamptz value) is directly
    // sensitive to Postgres's session `timezone` GUC (confirmed live:
    // identical stored instant gave a different HOUR depending on session
    // tz) while a customer's actual server/container default is out of
    // Nia's control and not guaranteed to be UTC. Without this, date-part
    // pushdown results would silently vary by whatever tz the target
    // Postgres happens to be configured with — the exact "collation
    // problem" this batch's UTC-everywhere pin exists to close. Applied
    // per-connection (pg's 'connect' event fires once per new physical
    // socket the pool opens, not per query), so it's paid once, not
    // per-query, and survives pool churn/reconnects automatically.
    pool.on("connect", (client) => {
      client.query("SET TIME ZONE 'UTC'").catch(() => {
        // Best-effort: a role without SET privileges (unlikely, but not
        // guaranteed for an arbitrary customer credential) shouldn't take
        // the whole pool down — date-part pushdown for that connection
        // would then inherit the server's default tz, a pre-existing
        // condition this pin improves on everywhere it succeeds.
      });
    });
    return pool;
  })();
  pools.set(key, { poolPromise, lastUsed: Date.now() });
  poolPromise.catch(() => {
    if (pools.get(key)?.poolPromise === poolPromise) pools.delete(key);
  });
  return poolPromise;
}

export async function getPool(cred: CredentialRef, config: ConnectorConfig): Promise<pg.Pool> {
  return createPool(`${cred.connectionId}:${cred.credVersion}`, cred, config);
}

/**
 * Fail-fast startup probe — every credential resolution on this service
 * goes through `resolveSecret()` above, which reaches the app database
 * over `process.env.DATABASE_URL`. If that URL isn't reachable from inside
 * this container (wrong host — e.g. a host-only `127.0.0.1`/`localhost`
 * value copied from a native `.env`, which inside a Docker container's
 * network namespace never routes to the host), every single `/introspect`,
 * `/test`, `/execute`, `/stage`, `/write` call would individually fail
 * with a generic connection error — often minutes into a run, once the
 * nia_secrets lookup is finally attempted. Calling this once at process
 * start turns that into one clear, immediate failure instead.
 */
export async function checkDbReachable(): Promise<void> {
  try {
    await dbPool.query("select 1");
  } catch (err) {
    throw new Error(
      // Never interpolate the raw URL into a thrown/logged message — it's
      // a connection URL, one of the categories the production-readiness
      // pass requires stay out of logs, even though this particular one
      // carries no embedded credentials.
      `Cannot reach the database at DATABASE_URL (value redacted from logs): ${err instanceof Error ? err.message : String(err)}. ` +
        `If this service runs in Docker and DATABASE_URL points at 127.0.0.1/localhost, that address resolves to ` +
        `the container itself, not the host — use the database's internal Docker network name (or host.docker.internal) instead.`,
    );
  }
}

/**
 * Phase 6 Block 2 — write path gets its own pool, keyed
 * `connectionId:write:credVersion`, so a write credential's connections
 * never share a socket with the read pool (different Postgres role,
 * different privilege level, different vaultRef). `cred.credVersion` here
 * is the write grant's own cred_version (0016_write_grants.sql), not the
 * connection's read-side one — rotating the write credential ages out
 * this pool independently of the read pool, same mechanism as read-side
 * rotation.
 */
export async function getWritePool(cred: CredentialRef, config: ConnectorConfig): Promise<pg.Pool> {
  return createPool(`${cred.connectionId}:write:${cred.credVersion}`, cred, config);
}

/**
 * Phase 6 Block 2 — connector-side re-check of the write grant referenced
 * by the signed context, independent of the worker's own pre-dispatch
 * check (see contract.ts's WriteContext comment: "two layers even inside
 * the internal network"). write_grants has no org_id/owner_id of its own
 * (0007_connectors.sql/apps/api/src/services/grants.ts's header comment) —
 * scope is entirely the parent connection's, which the worker already
 * resolved under WorkspaceScope before it ever signed this context, so a
 * direct service-role lookup by grantId+connectionId here is a re-check of
 * that same fact, not a fresh authorization decision.
 */
export async function verifyActiveWriteGrant(
  grantId: string,
  connectionId: string,
  namespace: string,
): Promise<boolean> {
  const { rows } = await withServiceRole(dbPool, (db) =>
    db.query<{ scope: { schemas?: unknown } | null; confirmed_at: Date | null; revoked_at: Date | null }>(
      `select scope, confirmed_at, revoked_at from write_grants where id = $1 and connection_id = $2`,
      [grantId, connectionId],
    ),
  );
  const data = rows[0];
  if (!data) return false;
  if (!data.confirmed_at || data.revoked_at) return false;
  const schemas = data.scope?.schemas;
  return Array.isArray(schemas) && schemas.includes(namespace);
}

export async function evict(connectionId: string): Promise<boolean> {
  let evicted = false;
  for (const [key, entry] of [...pools]) {
    if (key.startsWith(`${connectionId}:`)) {
      pools.delete(key);
      evicted = true;
      try {
        const pool = await entry.poolPromise;
        await pool.end();
      } catch {
        // Never resolved — nothing live to close.
      }
    }
  }
  return evicted;
}

export function poolCount(): number {
  return pools.size;
}

setInterval(async () => {
  const now = Date.now();
  for (const [key, entry] of [...pools]) {
    if (now - entry.lastUsed > IDLE_EVICT_MS) {
      pools.delete(key);
      try {
        const pool = await entry.poolPromise;
        await pool.end();
      } catch {
        // Never resolved — nothing live to close.
      }
    }
  }
}, 60_000).unref();
