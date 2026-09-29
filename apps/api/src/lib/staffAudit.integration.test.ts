import { afterAll, describe, expect, it } from "vitest";
import { withServiceRole } from "@nia/db";
import { dbPool } from "./dbPool.js";

/**
 * Console v1 Slice 1 review fix (docs/plans/console-plan.md): proves
 * `private.log_staff_action()` is actually callable through
 * `withServiceRole` — the SAME code path `requireStaff.ts`'s platform_staff
 * check and every `/console/*` route's audit write use (`SET LOCAL ROLE
 * service_role` on a pooled connection, per packages/db/src/client.ts) —
 * not `manageStaff.atomicity.integration.test.ts`'s `withTransaction`,
 * which runs as the raw DATABASE_URL owner role and would still pass even
 * if 0041_private_schema_usage_for_service_role.sql's grant were missing
 * (an owner role bypasses schema-usage grants entirely; that's exactly why
 * the "permission denied for schema private" bug 0041 fixes was only ever
 * caught live, against apps/api's real request path — see 0041's own
 * header comment). This test exercises that real request path directly, so
 * a future migration that drops or narrows the grant fails this suite
 * immediately instead of only surfacing in production.
 *
 * Real local Postgres only (apps/api/.env's DATABASE_URL, same instance
 * manageStaff.atomicity.integration.test.ts uses). Run explicitly with
 * `pnpm test:integration` (apps/api/vitest.integration.config.ts).
 */

const STAFF_EMAIL = "canvas-e2e-a@nia.dev";
let staffUserId: string;

async function countAuditRowsForStaff(): Promise<number> {
  const { rowCount } = await dbPool.query(
    "select 1 from public.staff_audit_log where staff_user_id = $1 and action = 'test.withServiceRole'",
    [staffUserId],
  );
  return rowCount ?? 0;
}

afterAll(async () => {
  await dbPool.end();
});

describe("private.log_staff_action via withServiceRole — real Postgres", () => {
  it("a service_role connection can resolve and call private.log_staff_action (proves 0041's schema-usage grant, not just log_staff_action's own EXECUTE grant)", async () => {
    const staff = await dbPool.query<{ id: string }>('select id from "user" where email = $1', [STAFF_EMAIL]);
    if (!staff.rows[0]) {
      throw new Error(`fixture user ${STAFF_EMAIL} not found — run \`pnpm --filter @nia/api seed:fixtures\` first`);
    }
    staffUserId = staff.rows[0].id;

    const auditRowsBefore = await countAuditRowsForStaff();

    // Exactly the pattern requireStaff.ts / routes/console.ts use: dbPool +
    // withServiceRole from "@nia/db", never a raw client on the
    // DATABASE_URL owner role.
    await withServiceRole(dbPool, (db) =>
      db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        staffUserId,
        "test.withServiceRole",
        null,
        null,
        JSON.stringify({ proof: "0041 grant" }),
      ]),
    );

    expect(await countAuditRowsForStaff()).toBe(auditRowsBefore + 1);
  });
});
