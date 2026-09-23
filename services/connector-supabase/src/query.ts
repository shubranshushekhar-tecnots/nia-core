import type pg from "pg";

/**
 * Runs `sql`/`params` on a dedicated connection with a server-side
 * statement_timeout, driven by `timeoutMs` (ExecuteRequest.timeoutMs) — not
 * a fixed constant. Postgres enforces this itself and cancels the query
 * mid-flight if it runs long, which is a stronger guarantee than mysql2's
 * client-side `timeout` option (that just stops waiting on the client; the
 * server keeps running the query).
 *
 * `SET LOCAL` only takes effect for the current transaction, so the query
 * is wrapped in BEGIN/COMMIT: this scopes the timeout to exactly this one
 * query on this checked-out connection, and the connection goes back to the
 * pool with no lingering session-level setting for whatever query runs on
 * it next. `SET LOCAL` doesn't support parameter placeholders (it's a
 * config command, not a data statement), so the integer is inlined
 * directly — safe here because it's the zod-validated numeric
 * ExecuteRequest.timeoutMs, never user-supplied SQL text.
 */
export async function executeWithStatementTimeout(
  pool: pg.Pool,
  sql: string,
  params: unknown[],
  timeoutMs: number,
): Promise<pg.QueryResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = ${Math.trunc(timeoutMs)}`);
    const result = await client.query({ text: sql, values: params });
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // Connection may already be unusable (e.g. the statement_timeout
      // cancellation itself aborted the transaction) — nothing more to do.
    });
    throw err;
  } finally {
    client.release();
  }
}
