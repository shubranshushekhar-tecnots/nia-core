import type { WithUser } from "../lib/withUser.js";

/**
 * Subscription Phase 5, Slice 4 (docs/plans/subscription-model.md, decision
 * 1). Customer-facing reads/writes for the app-shell banner — mirrors
 * services/dashboard.ts's/services/projects.ts's shape (plain RLS-scoped
 * selects via the caller's own withUser, no service role, no scope param
 * since announcements.ts's RLS policies (0067_announcements.sql,
 * `announcements_select_targeted`) already resolve targeting/audience
 * entirely from auth.uid() — there's no org/project id this route needs to
 * pass in).
 */
export type ActiveAnnouncement = {
  id: string;
  title: string;
  body: string;
  severity: "info" | "warning" | "critical";
};

type ActiveAnnouncementRow = {
  id: string;
  title: string;
  body: string;
  severity: "info" | "warning" | "critical";
};

/**
 * Returns at most 3 announcements currently targeting the caller that they
 * have not dismissed, critical severity first. RLS
 * (`announcements_select_targeted`) already restricts the base select to
 * active + targeted rows; the LEFT JOIN here only adds the "not already
 * dismissed by this user" filter — a critical-severity row can never gain a
 * dismissal row in the first place (see dismissAnnouncement below /
 * `announcement_dismissals_insert_own`'s WITH CHECK), so it keeps showing
 * here for exactly as long as RLS keeps it targeted/active.
 */
export async function getActiveAnnouncements(withUser: WithUser, userId: string): Promise<ActiveAnnouncement[]> {
  const result = await withUser((db) =>
    db.query<ActiveAnnouncementRow>(
      `SELECT a.id, a.title, a.body, a.severity
       FROM announcements a
       LEFT JOIN announcement_dismissals d ON d.announcement_id = a.id AND d.user_id = $1
       WHERE d.announcement_id IS NULL
       ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.starts_at DESC
       LIMIT 3`,
      [userId],
    ),
  );
  return result.rows;
}

/**
 * Inserts the caller's own dismissal row. `ON CONFLICT DO NOTHING` makes a
 * repeat dismiss of the same announcement a harmless no-op instead of a
 * unique-violation error (composite PK on (announcement_id, user_id)).
 * `announcement_dismissals_insert_own`'s WITH CHECK rejects this outright
 * for a critical-severity announcement (42501, insufficient_privilege) —
 * the route layer maps that to a friendly 403; the banner itself never
 * renders a dismiss control for a critical announcement, so this only ever
 * fires if a client is out of sync or bypassing the UI.
 */
export async function dismissAnnouncement(withUser: WithUser, userId: string, announcementId: string): Promise<void> {
  await withUser((db) =>
    db.query(
      `INSERT INTO announcement_dismissals (announcement_id, user_id) VALUES ($1, $2)
       ON CONFLICT (announcement_id, user_id) DO NOTHING`,
      [announcementId, userId],
    ),
  );
}
