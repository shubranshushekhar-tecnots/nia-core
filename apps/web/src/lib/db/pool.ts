import { createDbPool } from "@nia/db";
import type pg from "pg";

/**
 * One pool for the process — mirrors apps/api/src/lib/dbPool.ts. Server
 * Actions call `withActingUser(dbPool, user.id, ...)` directly (no
 * middleware layer here to stash a `req.withUser` closure on), so this
 * module only needs to export the pool itself.
 */
export const dbPool: pg.Pool = createDbPool({
  connectionString: process.env.DATABASE_URL!,
  max: 10,
});
