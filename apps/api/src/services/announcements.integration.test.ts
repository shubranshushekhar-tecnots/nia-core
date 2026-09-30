import { afterAll, describe, expect, it } from "vitest";
import { withActingUser } from "@nia/db";
import type { Queryable } from "@nia/db";
import { dbPool } from "../lib/dbPool.js";
import { getActiveAnnouncements, dismissAnnouncement } from "./announcements.js";

/**
 * Subscription Phase 5, Slice 4 (docs/plans/subscription-model.md, decision
 * 1). Two mandatory paths from the task spec: dismissing an info
 * announcement hides it (allowed path) and a critical announcement can't
 * be dismissed (refused path, RLS-enforced by
 * announcement_dismissals_insert_own's WITH CHECK — 0067_announcements.sql).
 * "A user only sees announcements targeting them" is already covered by
 * the RLS probe suite (supabase/tests/rls_probes.sql, probes 115-121) —
 * this file only proves the app-layer query built on top of that RLS
 * (the LEFT JOIN .. IS NULL "not dismissed" filter) actually works, not
 * the targeting itself again.
 *
 * Real local Postgres only (apps/api/.env's DATABASE_URL). Run explicitly
 * with `pnpm test:integration` (apps/api/vitest.integration.config.ts).
 */

afterAll(async () => {
  await dbPool.end();
});

describe("announcements service — real Postgres", () => {
  it("an info announcement disappears from getActiveAnnouncements once dismissed", async () => {
    const { rows: userRows } = await dbPool.query<{ id: string }>('select id from public."user" limit 1');
    const userId = userRows[0]?.id;
    expect(userId).toBeTruthy();

    const { rows: annRows } = await dbPool.query<{ id: string }>(
      `insert into public.announcements (title, body, severity, audience, created_by)
       values ($1, $2, 'info', 'all', $3)
       returning id`,
      ["announcements service test — info", "dismiss-me", userId],
    );
    const announcementId = annRows[0]?.id;
    expect(announcementId).toBeTruthy();

    const withUser = <T>(fn: (db: Queryable) => Promise<T>): Promise<T> => withActingUser(dbPool, userId!, fn);

    try {
      const before = await getActiveAnnouncements(withUser, userId!);
      expect(before.some((a) => a.id === announcementId)).toBe(true);

      await dismissAnnouncement(withUser, userId!, announcementId!);

      const after = await getActiveAnnouncements(withUser, userId!);
      expect(after.some((a) => a.id === announcementId)).toBe(false);
    } finally {
      await dbPool.query("delete from public.announcements where id = $1", [announcementId]);
    }
  });

  it("a critical announcement can't be dismissed — RLS rejects the insert (42501), and it keeps showing", async () => {
    const { rows: userRows } = await dbPool.query<{ id: string }>('select id from public."user" limit 1');
    const userId = userRows[0]?.id;
    expect(userId).toBeTruthy();

    const { rows: annRows } = await dbPool.query<{ id: string }>(
      `insert into public.announcements (title, body, severity, audience, created_by)
       values ($1, $2, 'critical', 'all', $3)
       returning id`,
      ["announcements service test — critical", "cannot-dismiss-me", userId],
    );
    const announcementId = annRows[0]?.id;
    expect(announcementId).toBeTruthy();

    const withUser = <T>(fn: (db: Queryable) => Promise<T>): Promise<T> => withActingUser(dbPool, userId!, fn);

    try {
      await expect(dismissAnnouncement(withUser, userId!, announcementId!)).rejects.toMatchObject({
        code: "42501",
      });

      const after = await getActiveAnnouncements(withUser, userId!);
      expect(after.some((a) => a.id === announcementId)).toBe(true);
    } finally {
      await dbPool.query("delete from public.announcements where id = $1", [announcementId]);
    }
  });
});
