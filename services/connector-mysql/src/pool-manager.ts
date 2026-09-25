import mysql from "mysql2/promise";
import { createClient } from "@supabase/supabase-js";
import { createEnvKeySecretStore } from "@nia/secrets";
import type { ConnectorConfig, CredentialRef } from "@nia/schemas";

/**
 * Pool manager — warm connections keyed by `connectionId:credVersion`.
 * Lazy-created, idle-evicted, socket-capped so Nia never exhausts a
 * customer's small database tier. Credential rotation bumps credVersion,
 * so stale pools simply stop being hit and age out.
 *
 * A pool is composed from two sources: `config` (host/port/database — sent
 * by Express on every dispatch call, since it lives in Postgres directly)
 * and the nia_secrets secret (user/password — resolved here, inside the
 * service, and never sent by or back to Express).
 */

const POOL_LIMIT_PER_CONNECTION = 3;
const IDLE_EVICT_MS = 5 * 60 * 1000;

// Keyed by the in-flight/settled Promise<Pool>, not the resolved Pool
// itself. getPool() writes this synchronously, before its first await —
// so concurrent first calls for the same key all see (and await) the same
// promise instead of each racing past the cache check and creating their
// own pool. If the promise rejects (e.g. secret resolution fails), the
// rejection handler below removes the key so the next call gets a clean
// retry instead of being stuck replaying the same failure forever.
type Entry = { poolPromise: Promise<mysql.Pool>; lastUsed: number };
const pools = new Map<string, Entry>();

function parseMysqlConfig(config: ConnectorConfig): { host: string; port: number; database: string } {
  const host = config.host;
  const port = Number(config.port);
  const database = config.database;
  if (typeof host !== "string" || !host) throw new Error("config.host must be a non-empty string");
  if (!Number.isInteger(port) || port <= 0) throw new Error("config.port must be a positive integer");
  if (typeof database !== "string" || !database) throw new Error("config.database must be a non-empty string");
  return { host, port, database };
}

// Service-role client, used for: reading nia_secrets directly
// (service_role bypasses its RLS, granted select in 0032_nia_secrets.sql)
// and write_grants lookups. Never touches any other table. Vault's
// resolve_connector_secret RPC (legacy fallback) was dropped once every
// live ref was confirmed backfilled into nia_secrets — see
// docs/decisions.md's Vault-removal entry.
const supabase = createClient(
  process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false, autoRefreshToken: false } },
);

// docs/plans/secret-storage.md — nia_secrets (envelope-encrypted under
// NIA_SECRET_MASTER_KEY). Constructed at module load so a missing/
// malformed master key fails fast at process start, same as the
// pre-existing checkSupabaseReachable probe below.
const secretStore = createEnvKeySecretStore({
  client: supabase,
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

// Follow-up item 1 — non-strict sql_mode lets MySQL silently coerce bad
// writes instead of erroring (invalid string -> 0, over-length strings
// truncated, invalid dates stored as 0000-00-00), with only a warning.
// Every write-pool connection gets this set once, right after it's
// established (below), so it's in effect for every query run over it —
// staging inserts, the staging->dest apply, and the direct /write upsert
// path all share this one write pool per connection/credVersion.
const STRICT_SQL_MODE = "STRICT_ALL_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO";

function createPool(key: string, cred: CredentialRef, config: ConnectorConfig, opts: { strictSqlMode?: boolean } = {}): Promise<mysql.Pool> {
  const existing = pools.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.poolPromise;
  }

  // Build the promise and write it to the cache before any await runs —
  // that's what closes the race: every concurrent caller sees this same
  // Entry, not just the one that happens to finish resolveSecret last.
  const poolPromise = (async () => {
    const { host, port, database } = parseMysqlConfig(config);
    const secret = await resolveSecret(cred.vaultRef);
    const pool = mysql.createPool({
      host,
      port,
      database,
      ...secret,
      connectionLimit: POOL_LIMIT_PER_CONNECTION,
      waitForConnections: true,
      // Phase 10 Step 1 — mysql2 defaults DECIMAL/NEWDECIMAL columns to JS
      // strings (e.g. "10.00") on every read, connector-wide, not just the
      // Phase 9 aggregate-pagination groupBy path that first surfaced it.
      // Forced to float64 here, mirroring connector-supabase's pg.types
      // NUMERIC (OID 1700) fix in pool-manager.ts: consistent with the
      // documented numeric-precision constraint (docs/decisions.md,
      // Phase 8b-2 numeric-precision probe) that Nia Core does not
      // preserve arbitrary-precision decimals beyond float64.
      decimalNumbers: true,
    });
    if (opts.strictSqlMode) {
      // mysql2 queues queries per-connection in issue order, so this
      // fire-and-forget SET SESSION (issued the instant the connection is
      // established, before the pool ever hands it out) always runs before
      // any caller's query on that same connection — no explicit await
      // needed here, and none of this pool's callers need to know about it.
      pool.on("connection", (connection) => {
        connection.query(`SET SESSION sql_mode = '${STRICT_SQL_MODE}'`).catch(() => {
          // Best-effort: a failure here surfaces as normal write errors on
          // the connection's next real query rather than being swallowed
          // silently — nothing else to do with it in this event handler.
        });
      });
    }
    return pool;
  })();
  pools.set(key, { poolPromise, lastUsed: Date.now() });
  poolPromise.catch(() => {
    if (pools.get(key)?.poolPromise === poolPromise) pools.delete(key);
  });
  return poolPromise;
}

export async function getPool(cred: CredentialRef, config: ConnectorConfig): Promise<mysql.Pool> {
  return createPool(`${cred.connectionId}:${cred.credVersion}`, cred, config);
}

/**
 * Fail-fast startup probe — mirrors connector-supabase's pool-manager.ts
 * checkSupabaseReachable() exactly (same rationale: every credential
 * resolution here goes through resolveSecret() above, over
 * SUPABASE_URL; an unreachable URL would otherwise only surface as a
 * generic `TypeError: fetch failed` on the first real request, often
 * minutes into a run). Hits Auth's `/auth/v1/health` purely as a network-
 * reachability probe.
 */
export async function checkSupabaseReachable(): Promise<void> {
  const base = process.env.SUPABASE_URL ?? "";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(`${base}/auth/v1/health`, { signal: controller.signal });
  } catch (err) {
    throw new Error(
      `Cannot reach Supabase at SUPABASE_URL="${base}": ${err instanceof Error ? err.message : String(err)}. ` +
        `If this service runs in Docker and SUPABASE_URL points at 127.0.0.1/localhost, that address resolves to ` +
        `the container itself, not the host — use host.docker.internal (or a reachable network address) instead.`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Phase 6 Block 5 — write path gets its own pool, keyed
 * `connectionId:write:credVersion`, mirroring connector-supabase's
 * getWritePool exactly: a write credential never shares a socket with the
 * read pool (different MySQL user, different privilege level, different
 * vaultRef). `cred.credVersion` here is the write grant's own cred_version
 * (0016_write_grants.sql), not the connection's read-side one.
 */
export async function getWritePool(cred: CredentialRef, config: ConnectorConfig): Promise<mysql.Pool> {
  return createPool(`${cred.connectionId}:write:${cred.credVersion}`, cred, config, { strictSqlMode: true });
}

/**
 * Phase 6 Block 5 — connector-side re-check of the write grant referenced
 * by the signed context, independent of the worker's own pre-dispatch
 * check. Mirrors connector-supabase's verifyActiveWriteGrant exactly (same
 * write_grants table, same service-role lookup) — see that file's comment
 * for the full rationale.
 */
export async function verifyActiveWriteGrant(
  grantId: string,
  connectionId: string,
  namespace: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("write_grants")
    .select("scope, confirmed_at, revoked_at")
    .eq("id", grantId)
    .eq("connection_id", connectionId)
    .maybeSingle();
  if (error || !data) return false;
  if (!data.confirmed_at || data.revoked_at) return false;
  const schemas = (data.scope as { schemas?: unknown } | null)?.schemas;
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
