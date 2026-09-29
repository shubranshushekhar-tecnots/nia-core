import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbPool } from "../lib/dbPool.js";
import { applyResetTwoFactor } from "./manageStaff.js";

/**
 * Real local Postgres only (same convention as
 * manageStaff.atomicity.integration.test.ts — see that file's header for
 * the full fixture-user rationale). Proves Console v1 Slice 4's one
 * required test for `manageStaff reset-2fa` (console-plan.md §4b): it
 * clears the target's 2FA enrollment AND deletes all their sessions,
 * audited, in the same transaction pattern as grant/revoke.
 *
 * Reuses applyResetTwoFactor — the exact primitive the CLI's reset-2fa
 * command calls — rather than duplicating its SQL here.
 *
 * Uses canvas-e2e-a@nia.dev as the acting staff member and
 * canvas-e2e-b@nia.dev as the reset target (same fixtures
 * manageStaff.atomicity.integration.test.ts uses). twoFactor/session rows
 * for the target are seeded directly, then cleaned up afterward;
 * platform_staff is reset before/after (ordinary upsertable table);
 * staff_audit_log is never deleted from (append-only) — asserted as a
 * count delta, same convention as the sibling test file.
 *
 * Run explicitly with `pnpm test:integration` (apps/api/vitest.integration.config.ts).
 */

let actorId: string;
let targetId: string;

async function countAuditRowsForTarget(): Promise<number> {
  const { rowCount } = await dbPool.query("select 1 from public.staff_audit_log where target_user_id = $1", [
    targetId,
  ]);
  return rowCount ?? 0;
}

beforeAll(async () => {
  const actor = await dbPool.query<{ id: string }>('select id from "user" where email = $1', [
    "canvas-e2e-a@nia.dev",
  ]);
  const target = await dbPool.query<{ id: string }>('select id from "user" where email = $1', [
    "canvas-e2e-b@nia.dev",
  ]);
  if (!actor.rows[0] || !target.rows[0]) {
    throw new Error(
      "fixture users canvas-e2e-a@nia.dev / canvas-e2e-b@nia.dev not found — run `pnpm --filter @nia/api seed:fixtures` first",
    );
  }
  actorId = actor.rows[0].id;
  targetId = target.rows[0].id;

  await dbPool.query("delete from public.platform_staff where user_id in ($1, $2)", [actorId, targetId]);
  await dbPool.query(
    `insert into public.platform_staff (user_id, granted_by, granted_at) values ($1, $1, now())`,
    [actorId],
  );

  // Seed the target with a 2FA enrollment and two live sessions, so the
  // reset has something real to clear.
  await dbPool.query('delete from public."twoFactor" where "userId" = $1', [targetId]);
  await dbPool.query('delete from public."session" where "userId" = $1', [targetId]);
  await dbPool.query(
    `insert into public."twoFactor" (secret, "backupCodes", "userId") values ('secret', 'codes', $1)`,
    [targetId],
  );
  await dbPool.query('update public."user" set "twoFactorEnabled" = true where id = $1', [targetId]);
  await dbPool.query(
    `insert into public."session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
     values (gen_random_uuid(), now() + interval '1 day', 'reset-2fa-test-token-1', now(), now(), $1),
            (gen_random_uuid(), now() + interval '1 day', 'reset-2fa-test-token-2', now(), now(), $1)`,
    [targetId],
  );
});

afterAll(async () => {
  await dbPool.query("delete from public.platform_staff where user_id in ($1, $2)", [actorId, targetId]);
  await dbPool.query('delete from public."twoFactor" where "userId" = $1', [targetId]);
  await dbPool.query('delete from public."session" where "userId" = $1', [targetId]);
  await dbPool.query('update public."user" set "twoFactorEnabled" = false where id = $1', [targetId]);
  await dbPool.end();
});

describe("manageStaff.ts reset-2fa — real Postgres", () => {
  it("clears the target's 2FA enrollment, deletes all their sessions, and writes one audit row", async () => {
    const auditRowsBefore = await countAuditRowsForTarget();

    await applyResetTwoFactor(targetId, actorId, "canvas-e2e-b@nia.dev");

    const { rowCount: twoFactorRows } = await dbPool.query('select 1 from public."twoFactor" where "userId" = $1', [
      targetId,
    ]);
    expect(twoFactorRows).toBe(0);

    const { rows: userRows } = await dbPool.query<{ twoFactorEnabled: boolean }>(
      'select "twoFactorEnabled" from public."user" where id = $1',
      [targetId],
    );
    expect(userRows[0]?.twoFactorEnabled).toBe(false);

    const { rowCount: sessionRows } = await dbPool.query('select 1 from public."session" where "userId" = $1', [
      targetId,
    ]);
    expect(sessionRows).toBe(0);

    expect(await countAuditRowsForTarget()).toBe(auditRowsBefore + 1);
    const { rows: latestAudit } = await dbPool.query<{ action: string; staff_user_id: string }>(
      "select action, staff_user_id from public.staff_audit_log where target_user_id = $1 order by created_at desc limit 1",
      [targetId],
    );
    expect(latestAudit[0]).toMatchObject({ action: "staff.reset_2fa", staff_user_id: actorId });
  });
});
