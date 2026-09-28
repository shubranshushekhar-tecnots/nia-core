import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbPool } from "../lib/dbPool.js";
import { logStaffAction, withTransaction } from "./manageStaff.js";

/**
 * Real local Postgres only (apps/api/.env's DATABASE_URL — the local dev
 * instance, same role manageStaff.ts and migrate.mjs run as). Proves Console
 * v1 Step 3's atomicity requirement (docs/plans/console-plan.md build order
 * step 3, follow-up item 4): grant()/revoke()'s platform_staff mutation and
 * its staff_audit_log write run in ONE transaction via withTransaction — if
 * the audit insert fails, the platform_staff mutation in the same
 * transaction is rolled back too.
 *
 * Reuses the exact withTransaction/logStaffAction primitives grant()/
 * revoke() call (both exported from manageStaff.ts for this purpose),
 * rather than duplicating their SQL, so this is a genuine proof of the real
 * code path's atomicity, not just of the general transaction mechanism.
 *
 * Uses two of seedFixtureUsers.ts's stable fixture identities
 * (canvas-e2e-a@nia.dev as the granter, canvas-e2e-b@nia.dev as the
 * mutation target) rather than demo@nia.dev, whose platform_staff state is
 * exercised by manual CLI testing elsewhere and so isn't safe to assume
 * clean. platform_staff is reset before/after by this test (it's an
 * ordinary upsertable table); staff_audit_log is NEVER deleted from — that
 * table is append-only by design (0040_staff_audit_log.sql), so every
 * assertion below is expressed as a count DELTA around each test's own
 * action, never an absolute "starts at zero".
 *
 * Run explicitly with `pnpm test:integration` (apps/api/vitest.integration.config.ts).
 */

let granterId: string;
let targetId: string;

async function countAuditRowsForTarget(): Promise<number> {
  const { rowCount } = await dbPool.query("select 1 from public.staff_audit_log where target_user_id = $1", [
    targetId,
  ]);
  return rowCount ?? 0;
}

beforeAll(async () => {
  const granter = await dbPool.query<{ id: string }>('select id from "user" where email = $1', [
    "canvas-e2e-a@nia.dev",
  ]);
  const target = await dbPool.query<{ id: string }>('select id from "user" where email = $1', [
    "canvas-e2e-b@nia.dev",
  ]);
  if (!granter.rows[0] || !target.rows[0]) {
    throw new Error(
      "fixture users canvas-e2e-a@nia.dev / canvas-e2e-b@nia.dev not found — run `pnpm --filter @nia/api seed:fixtures` first",
    );
  }
  granterId = granter.rows[0].id;
  targetId = target.rows[0].id;

  // Reset both fixtures' platform_staff rows to a known-clean state
  // regardless of any prior run's outcome (platform_staff is an ordinary
  // upsertable table, unlike staff_audit_log).
  await dbPool.query("delete from public.platform_staff where user_id in ($1, $2)", [granterId, targetId]);

  // Make the granter an active staff member directly (bypassing the CLI —
  // that's the thing under test, not this fixture setup).
  await dbPool.query(
    `insert into public.platform_staff (user_id, granted_by, granted_at) values ($1, $1, now())`,
    [granterId],
  );
});

afterAll(async () => {
  await dbPool.query("delete from public.platform_staff where user_id in ($1, $2)", [granterId, targetId]);
  await dbPool.end();
});

describe("manageStaff.ts atomicity — real Postgres", () => {
  it("rolls back the platform_staff mutation when the same-transaction audit insert fails", async () => {
    const bogusTargetUserId = "00000000-0000-0000-0000-000000000000"; // not in public."user" — violates staff_audit_log's FK
    const auditRowsBefore = await countAuditRowsForTarget();

    await expect(
      withTransaction(async (client) => {
        await client.query(
          `insert into public.platform_staff (user_id, granted_by, granted_at) values ($1, $2, now())`,
          [targetId, granterId],
        );
        // Forces the FK violation on staff_audit_log.target_user_id — the
        // failure this test needs, on the exact primitive grant() uses.
        await logStaffAction(client, granterId, "staff.grant", bogusTargetUserId, { email: "canvas-e2e-b@nia.dev" });
      }),
    ).rejects.toThrow(/staff_audit_log_target_user_id_fkey/);

    const { rowCount: platformStaffRows } = await dbPool.query(
      "select 1 from public.platform_staff where user_id = $1",
      [targetId],
    );
    expect(platformStaffRows).toBe(0);
    expect(await countAuditRowsForTarget()).toBe(auditRowsBefore); // no orphaned audit row either — the whole transaction rolled back
  });

  it("commits both the platform_staff mutation and its audit row together when nothing fails", async () => {
    const auditRowsBefore = await countAuditRowsForTarget();

    await withTransaction(async (client) => {
      await client.query(
        `insert into public.platform_staff (user_id, granted_by, granted_at) values ($1, $2, now())`,
        [targetId, granterId],
      );
      await logStaffAction(client, granterId, "staff.grant", targetId, { email: "canvas-e2e-b@nia.dev" });
    });

    const { rows: staffRows } = await dbPool.query<{ user_id: string }>(
      "select user_id from public.platform_staff where user_id = $1",
      [targetId],
    );
    expect(staffRows).toHaveLength(1);
    expect(await countAuditRowsForTarget()).toBe(auditRowsBefore + 1);

    const { rows: latestAudit } = await dbPool.query<{ action: string; staff_user_id: string }>(
      "select action, staff_user_id from public.staff_audit_log where target_user_id = $1 order by created_at desc limit 1",
      [targetId],
    );
    expect(latestAudit[0]).toMatchObject({ action: "staff.grant", staff_user_id: granterId });
  });
});
