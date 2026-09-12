import { MongoClient, type Db } from "mongodb";
import { createClient } from "@supabase/supabase-js";
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

// Same role as connector-mysql's: resolve_connector_secret RPC only,
// nothing else — see that file's comment for the full rationale.
const supabase = createClient(
  process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function resolveVaultSecret(vaultRef: string): Promise<{ user: string; password: string }> {
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

export async function getDb(cred: CredentialRef, config: ConnectorConfig): Promise<Db> {
  const key = `${cred.connectionId}:${cred.credVersion}`;
  const existing = pools.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return (await existing.clientPromise).db;
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
  return (await clientPromise).db;
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
