import { MongoClient, type Db } from "mongodb";
import { createClient } from "@supabase/supabase-js";
import { createEnvKeySecretStore } from "@nia/secrets";
import type { ConnectorConfig, CredentialRef } from "@nia/schemas";

/**
 * Pool manager — mirrors connector-mysql/src/pool-manager.ts exactly:
 * warm clients keyed by `connectionId:credVersion`, lazy-created,
 * idle-evicted, socket-capped via MongoClient's own maxPoolSize (the
 * driver pools connections internally per client, same role mysql2's
 * `connectionLimit` plays).
 */

const POOL_LIMIT_PER_CONNECTION = 3;
const IDLE_EVICT_MS = 5 * 60 * 1000;

// Keyed by the in-flight/settled Promise<{client,db}>, not the resolved
// values — see connector-mysql/src/pool-manager.ts's Entry comment for
// why: getDb() writes this synchronously, before its first await, so
// concurrent first calls for the same key share one promise instead of
// each racing past the cache check and opening their own client. A
// rejection (e.g. vault resolution fails) removes the key so the next
// call gets a clean retry.
type Entry = { clientPromise: Promise<{ client: MongoClient; db: Db }>; lastUsed: number };
const pools = new Map<string, Entry>();

function parseMongoConfig(config: ConnectorConfig): { host: string; port: number; database: string } {
  const host = config.host;
  const port = Number(config.port);
  const database = config.database;
  if (typeof host !== "string" || !host) throw new Error("config.host must be a non-empty string");
  if (!Number.isInteger(port) || port <= 0) throw new Error("config.port must be a positive integer");
  if (typeof database !== "string" || !database) throw new Error("config.database must be a non-empty string");
  return { host, port, database };
}

// Same role as connector-mysql's: resolve_connector_secret RPC (legacy
// Vault fallback) + nia_secrets reads — see that file's comment for the
// full rationale.
const supabase = createClient(
  process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false, autoRefreshToken: false } },
);

// docs/plans/secret-storage.md — dual-read: nia_secrets checked first,
// resolve_connector_secret RPC (legacy Vault) as fallback. Mirrors
// connector-mysql/src/pool-manager.ts's wiring exactly.
const secretStore = createEnvKeySecretStore({
  client: supabase,
  masterKey: process.env.NIA_SECRET_MASTER_KEY ?? "",
  legacyResolve: async (ref) => {
    const { data, error } = await supabase.rpc("resolve_connector_secret", { p_ref: ref });
    if (error) throw new Error(`vault resolution failed for ref ${ref}: ${error.message}`);
    return (data as Record<string, unknown> | null) ?? null;
  },
});

async function resolveVaultSecret(vaultRef: string): Promise<{ user: string; password: string }> {
  const data = await secretStore.get(vaultRef);
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

function createMongoClient(key: string, cred: CredentialRef, config: ConnectorConfig): Promise<{ client: MongoClient; db: Db }> {
  const existing = pools.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.clientPromise;
  }

  // Build the promise and write it to the cache before any await runs —
  // that's what closes the race: every concurrent caller sees this same
  // Entry, not just the one that happens to finish connect() last.
  const clientPromise = (async () => {
    const { host, port, database } = parseMongoConfig(config);
    const secret = await resolveVaultSecret(cred.vaultRef);
    const uri = `mongodb://${encodeURIComponent(secret.user)}:${encodeURIComponent(secret.password)}@${host}:${port}/${database}`;
    const client = new MongoClient(uri, { maxPoolSize: POOL_LIMIT_PER_CONNECTION });
    await client.connect();
    return { client, db: client.db(database) };
  })();
  pools.set(key, { clientPromise, lastUsed: Date.now() });
  clientPromise.catch(() => {
    if (pools.get(key)?.clientPromise === clientPromise) pools.delete(key);
  });
  return clientPromise;
}

export async function getDb(cred: CredentialRef, config: ConnectorConfig): Promise<Db> {
  const { db } = await createMongoClient(`${cred.connectionId}:${cred.credVersion}`, cred, config);
  return db;
}

/**
 * Fail-fast startup probe — mirrors connector-supabase/connector-mysql's
 * pool-manager.ts checkVaultReachable() exactly (same rationale: every
 * credential resolution here goes through resolveVaultSecret() above, over
 * SUPABASE_URL; an unreachable URL would otherwise only surface as a
 * generic `TypeError: fetch failed` on the first real request, often
 * minutes into a run). Hits Auth's `/auth/v1/health` purely as a network-
 * reachability probe.
 */
export async function checkVaultReachable(): Promise<void> {
  const base = process.env.SUPABASE_URL ?? "";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(`${base}/auth/v1/health`, { signal: controller.signal });
  } catch (err) {
    throw new Error(
      `Cannot reach Supabase Vault at SUPABASE_URL="${base}": ${err instanceof Error ? err.message : String(err)}. ` +
        `If this service runs in Docker and SUPABASE_URL points at 127.0.0.1/localhost, that address resolves to ` +
        `the container itself, not the host — use host.docker.internal (or a reachable network address) instead.`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Phase 6 Block 5 — write path gets its own client, keyed
 * `connectionId:write:credVersion`, mirroring connector-mysql/
 * connector-supabase's getWritePool exactly: a write credential never
 * shares a connection with the read pool. `cred.credVersion` here is the
 * write grant's own cred_version (0016_write_grants.sql), not the
 * connection's read-side one.
 */
export async function getWriteDb(cred: CredentialRef, config: ConnectorConfig): Promise<Db> {
  const { db } = await createMongoClient(`${cred.connectionId}:write:${cred.credVersion}`, cred, config);
  return db;
}

/**
 * Phase 6 Block 5 — connector-side re-check of the write grant referenced
 * by the signed context, independent of the worker's own pre-dispatch
 * check. Mirrors connector-mysql/connector-supabase's verifyActiveWriteGrant
 * exactly (same write_grants table, same service-role lookup).
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
        const { client } = await entry.clientPromise;
        await client.close();
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
        const { client } = await entry.clientPromise;
        await client.close();
      } catch {
        // Never resolved — nothing live to close.
      }
    }
  }
}, 60_000).unref();
