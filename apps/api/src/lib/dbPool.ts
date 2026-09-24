import { createDbPool } from "@nia/db";
import type pg from "pg";
import { env } from "../env.js";

/**
 * One pool for the process (packages/db/src/pool.ts's header comment: both
 * withActingUser and withServiceRole share the same pool — privilege
 * narrowing happens per-transaction via SET LOCAL ROLE, not via a second
 * pool). apps/api never calls withServiceRole (see CONVENTIONS.md's trust
 * boundary — Express never holds service-role-equivalent access), but the
 * pool itself has no opinion on that; only route/service code does.
 */
export const dbPool: pg.Pool = createDbPool({
  connectionString: env.DATABASE_URL,
  max: 10,
});
