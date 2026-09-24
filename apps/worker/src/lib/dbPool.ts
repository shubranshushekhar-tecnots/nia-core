import { createDbPool } from "@nia/db";
import type pg from "pg";
import { env } from "../env.js";

/**
 * One pool for the process — mirrors apps/api/src/lib/dbPool.ts. Every
 * call site uses withServiceRole (never withActingUser — the worker has
 * no live user JWT, see env.ts's header comment and supabaseClient.ts's
 * header comment on the RLS-bypass it's replacing).
 */
export const dbPool: pg.Pool = createDbPool({
  connectionString: env.DATABASE_URL,
  max: 10,
});
