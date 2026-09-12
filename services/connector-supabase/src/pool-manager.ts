import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import type { ConnectorConfig, CredentialRef } from "@nia/schemas";

/**
 * Pool manager — warm connections keyed by `connectionId:credVersion`.
 * Lazy-created, idle-evicted, socket-capped so Nia never exhausts a
 * customer's small database tier. Credential rotation bumps credVersion,
 * so stale pools simply stop being hit and age out.
 *
 * A pool is composed from two sources: `config` (host/port/database/ssl —
 * sent by Express on every dispatch call, since it lives in Postgres, not
 * Vault) and the Vault secret (user/password — resolved here, inside the
 * service, and never sent by or back to Express).
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

function parsePostgresConfig(
  config: ConnectorConfig,
): { host: string; port: number; database: string; ssl: boolean } {
  const host = config.host;
  const port = Number(config.port);
  const database = config.database;
  const ssl = config.ssl === true;
  if (typeof host !== "string" || !host) throw new Error("config.host must be a non-empty string");
  if (!Number.isInteger(port) || port <= 0) throw new Error("config.port must be a positive integer");
  if (typeof database !== "string" || !database) throw new Error("config.database must be a non-empty string");
  return { host, port, database, ssl };
}

// Service-role client, used for exactly one thing: calling the
// resolve_connector_secret RPC (0008_connector_secret_rpc.sql). That RPC's
// EXECUTE grant is restricted to service_role and it returns only the one
// secret asked for by ref — this client never touches any other table.
const supabase = createClient(
  process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function resolveVaultSecret(vaultRef: string): Promise<{ user: string; password: string }> {
  // Fetched from Supabase Vault, here, inside the service — the decrypted
  // value never crosses back over the Express -> service boundary, and
  // Express never sees it: it only ever forwards the opaque vaultRef.
  const { data, error } = await supabase.rpc("resolve_connector_secret", { p_ref: vaultRef });
  if (error) throw new Error(`vault resolution failed for ref ${vaultRef}: ${error.message}`);
  if (
    typeof data !== "object" ||
    data === null ||
    typeof (data as Record<string, unknown>).user !== "string" ||
    typeof (data as Record<string, unknown>).password !== "string"
  ) {
    throw new Error(`vault secret ${vaultRef} is missing user/password`);
  }
  return { user: (data as { user: string }).user, password: (data as { password: string }).password };
}

export async function getPool(cred: CredentialRef, config: ConnectorConfig): Promise<pg.Pool> {
  const key = `${cred.connectionId}:${cred.credVersion}`;
  const existing = pools.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.poolPromise;
  }

  // Build the promise and write it to the cache before any await runs —
  // that's what closes the race: every concurrent caller sees this same
  // Entry, not just the one that happens to finish resolveVaultSecret last.
  const poolPromise = (async () => {
    const { host, port, database, ssl } = parsePostgresConfig(config);
    const secret = await resolveVaultSecret(cred.vaultRef);
    return new pg.Pool({
      host,
      port,
      database,
      user: secret.user,
      password: secret.password,
      max: POOL_LIMIT_PER_CONNECTION,
      ssl: ssl ? { rejectUnauthorized: false } : undefined,
    });
  })();
  pools.set(key, { poolPromise, lastUsed: Date.now() });
  poolPromise.catch(() => {
    if (pools.get(key)?.poolPromise === poolPromise) pools.delete(key);
  });
  return poolPromise;
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
