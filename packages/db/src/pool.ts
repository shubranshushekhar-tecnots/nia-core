import pg from "pg";

/**
 * node-postgres returns `bigint`/`numeric` columns (OID 20) as JS strings by
 * default, to avoid silent precision loss above Number.MAX_SAFE_INTEGER.
 * The only bigint column in this schema is workflow_runs.rows_processed
 * (0002_projects_workflows.sql), whose values never approach that range, but
 * every caller (services/dashboard.ts, services/runs.ts) declares it as a
 * plain TS `number` and sums it — e.g. `.reduce((sum, r) => sum +
 * r.rowsProcessed, 0)`. Left unparsed, that silently becomes STRING
 * concatenation (`0 + "10" + "10" + ...`), producing a garbage
 * "0101010101..."-looking value instead of a sum. Parsing OID 20 to a real
 * number here, once, for every pool this module creates, is the single
 * source-of-truth fix — no schema change, no query change.
 */
pg.types.setTypeParser(20, (value) => Number(value));

/**
 * One pg.Pool per calling service (apps/api, apps/web, apps/worker each call
 * this once at startup with their own `max`). There is deliberately no
 * separate "acting-user pool" vs "service-role pool" here — see client.ts's
 * header comment: both withActingUser and withServiceRole run against the
 * SAME pool and the same underlying login role (the DATABASE_URL role,
 * `postgres` in this project — see docs/plans/data-access.md's Step 2
 * report), and it's the per-transaction `SET LOCAL ROLE` that actually
 * narrows privileges. Splitting the pool in two would add a second set of
 * sockets without adding any real isolation, since both pools would
 * authenticate with the exact same credential anyway.
 *
 * SSL: hosted Supabase Postgres requires TLS; local Supabase
 * (`127.0.0.1`/`localhost`, `supabase start`) does not speak it at all.
 * Mirrors services/connector-supabase/src/pool-manager.ts's sandbox-host
 * detection (same reasoning: never silently downgrade a real host to
 * plaintext on a missing/typo'd config, but don't require TLS against the
 * local dev container either).
 */
const SANDBOX_HOST_PATTERN = /^(localhost|127\.0\.0\.1|host\.docker\.internal)$|\.internal$/i;

function resolveSsl(connectionString: string): pg.PoolConfig["ssl"] {
  let host: string;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    return undefined;
  }
  if (SANDBOX_HOST_PATTERN.test(host) || !host.includes(".")) return undefined;
  return { rejectUnauthorized: false };
}

export interface DbPoolConfig {
  /** Direct Postgres connection string (the same DATABASE_URL already used for migrations — see DEPLOYMENT.md). */
  connectionString: string;
  /** Max physical connections this service's pool may open. Sized per service — see DEPLOYMENT.md. */
  max: number;
  /** Milliseconds an idle connection may sit in the pool before being closed. Defaults to pg's own default (10s) if omitted. */
  idleTimeoutMillis?: number;
}

export function createDbPool(config: DbPoolConfig): pg.Pool {
  return new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
    idleTimeoutMillis: config.idleTimeoutMillis,
    ssl: resolveSsl(config.connectionString),
  });
}
