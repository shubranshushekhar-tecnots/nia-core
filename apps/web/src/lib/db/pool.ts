import { createDbPool } from "@nia/db";
import type pg from "pg";

/**
 * One pool for the process — mirrors apps/api/src/lib/dbPool.ts. Server
 * Actions call `withActingUser(getPool(), user.id, ...)` directly (no
 * middleware layer here to stash a `req.withUser` closure on), so this
 * module only needs to export the pool itself.
 *
 * Lazy by design: `next build`'s page-data-collection step imports every
 * route module (including ones that transitively import this file)
 * without DATABASE_URL set, so the pool must not be constructed — and
 * DATABASE_URL must not be validated — at module-import time. Both only
 * happen the first time a caller actually invokes getPool() (i.e. at
 * request time), never at import.
 */
let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set");
    }
    pool = createDbPool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
    });
  }
  return pool;
}
