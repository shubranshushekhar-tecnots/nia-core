import type pg from "pg";

/**
 * The slice of pg.PoolClient every query callback gets. Deliberately not
 * the raw pg.PoolClient itself: callers of withActingUser/withServiceRole
 * never get a `release()` method, so there's no way to release (or forget
 * to release) the connection themselves — see this file's header comment.
 */
export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
}

/**
 * packages/db — replaces PostgREST with direct SQL through the pg driver
 * (docs/plans/data-access.md). Two entry points, both below, and nothing
 * else: every caller in apps/api, apps/web, and apps/worker reaches
 * Postgres exclusively through one of these two functions. Neither ever
 * hands out the underlying pg.Pool or a raw pg.PoolClient — a caller can
 * only ever run queries through the Queryable passed into its callback,
 * for the lifetime of that callback.
 *
 * Both variants connect through the SAME pool, as the SAME login role (the
 * DATABASE_URL role — `postgres` in this project, both locally and on
 * hosted Supabase; see docs/plans/data-access.md's Step 2 report for why:
 * hosted Supabase never exposes the `authenticator` role's credentials to
 * project owners, only `postgres`, and `postgres` already has `SET ROLE`
 * membership in `authenticated`/`anon`/`service_role` — confirmed live
 * against the local instance). What actually narrows privileges per call
 * is `SET LOCAL ROLE`, run inside an explicit transaction:
 *
 * - `SET LOCAL` (not session-level `SET ROLE`) is scoped to the
 *   transaction and is GUARANTEED to revert automatically on COMMIT or
 *   ROLLBACK, even on an unexpected error path. That's what makes this
 *   safe to run on a pooled connection: a connection can never be
 *   returned to the pool still impersonating `authenticated`/`service_role`,
 *   because the only way out of the transaction (commit, rollback, or a
 *   dropped connection) always clears it first.
 * - Because `SET LOCAL` requires a transaction to have something to be
 *   local TO, every call below runs inside an explicit BEGIN/COMMIT even
 *   when the callback only issues one query. This is also exactly what
 *   satisfies the plan's separate "transaction helper" requirement: the
 *   callback can run as many queries as it needs, all on the one
 *   connection the role was set on — there is no second, different
 *   "transaction()" primitive, because withActingUser/withServiceRole
 *   already are that primitive.
 * - Migrating a Step 3 call site that today makes N independent
 *   `.from()/.rpc()` calls (each its own independent PostgREST
 *   transaction) must call withActingUser/withServiceRole N separate
 *   times, not bundle them into one shared transaction — bundling would
 *   silently change atomicity/rollback behaviour compared to today.
 *
 * request.jwt.claims is set (not request.jwt.claim.sub) to match exactly
 * what the plan specifies and what auth.uid()/auth.role() both read —
 * confirmed live that setting only this one GUC is sufficient for both to
 * resolve correctly. No migration in this repo reads any other JWT claim.
 */

async function withTransaction<T>(pool: pg.Pool, run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let result: T;
    try {
      result = await run(client);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
    await client.query("COMMIT");
    return result;
  } finally {
    // Always released back to the pool, whether COMMIT, ROLLBACK, or an
    // error from BEGIN/COMMIT itself was thrown above — the transaction
    // boundary above already guarantees SET LOCAL ROLE cannot outlive
    // this connection's return to the pool.
    client.release();
  }
}

/**
 * Runs `fn` as the given acting user: RLS applies exactly as it does for a
 * real PostgREST request from that user, and every SECURITY DEFINER
 * function that calls auth.uid() or branches on current_setting('role')
 * sees the same values a real user request would produce.
 */
export async function withActingUser<T>(
  pool: pg.Pool,
  userId: string,
  fn: (db: Queryable) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, async (client) => {
    await client.query("SET LOCAL ROLE authenticated");
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    return fn(client);
  });
}

/**
 * Runs `fn` as service_role: no acting user, RLS bypassed via
 * service_role's rolbypassrls attribute — matching today's worker
 * behaviour exactly (supabaseClient.ts's service-role client). Deliberately
 * a separate, differently-named function from withActingUser (never an
 * options flag on one shared function) so a caller cannot reach the
 * RLS-bypassing path by accident — e.g. by a wrong/defaulted boolean.
 *
 * auth.uid() is null inside fn (no request.jwt.claims is set) —
 * log_execution_audit/log_connection_audit both require an explicit
 * p_actor_user_id argument for exactly this caller type; see
 * docs/plans/data-access.md's Step 1 report.
 */
export async function withServiceRole<T>(pool: pg.Pool, fn: (db: Queryable) => Promise<T>): Promise<T> {
  return withTransaction(pool, async (client) => {
    await client.query("SET LOCAL ROLE service_role");
    return fn(client);
  });
}
