import type { Queryable } from "@nia/db";

/**
 * A request-scoped closure over the pool + the caller's own user id — see
 * middleware/db.ts's attachDb for where this gets constructed and
 * docs/plans/data-access.md's Step 3 for the migration this replaces
 * (req.supabase, a per-request PostgREST client).
 *
 * Call it once per independent query/transaction, exactly the way each
 * `.from()`/`.rpc()` call today is its own independent PostgREST request:
 * client.ts's header comment requires N separate withActingUser calls for
 * N independent PostgREST calls, never bundled into one shared
 * transaction, since bundling would silently change atomicity/rollback
 * behaviour compared to today. Two sequential `.eq()` chains off the SAME
 * builder are one PostgREST call (one withUser call); two independent
 * `supabase.from(...)` statements are two.
 */
export type WithUser = <T>(fn: (db: Queryable) => Promise<T>) => Promise<T>;
