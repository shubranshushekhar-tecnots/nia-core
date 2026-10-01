import type { Queryable } from "@nia/db";

/**
 * Console v2 Slice 6 — service layer for the Console dashboard home screen
 * (orgs, users, active users, runs per day, rows moved, needs-attention).
 * Same convention as usage.ts (Slice 4): every function takes the
 * already-opened `withServiceRole` connection (consoleDashboard.ts's routes
 * open exactly one per request), and does all aggregation in SQL, never in
 * JS. Token usage + cost for the dashboard reuses usage.ts's existing
 * getUsageSummary/getUsageTimeseries directly (no new query needed here) —
 * see consoleDashboard.ts's route file for that composition.
 */

export type DashboardOverview = {
  totalOrgs: number;
  totalUsers: number;
  activeUsers30d: number;
};

/**
 * `activeUsers30d` is defined as the count of distinct users with a
 * `session` row (public."session", better-auth's own table — 0035_better_
 * auth.sql) whose `updatedAt` falls in the last 30 days. better-auth bumps
 * a session's `updatedAt` on each authenticated request that extends it, so
 * this approximates "signed in or active within 30 days" without needing a
 * separate last-seen column anywhere.
 */
export async function getDashboardOverview(db: Queryable): Promise<DashboardOverview> {
  const result = await db.query<{
    total_orgs: string;
    total_users: string;
    active_users_30d: string;
  }>(
    `select
       (select count(*) from public.organizations) as total_orgs,
       (select count(*) from public."user") as total_users,
       (select count(distinct "userId") from public."session" where "updatedAt" > now() - interval '30 days') as active_users_30d`,
  );

  const row = result.rows[0];
  return {
    totalOrgs: Number(row?.total_orgs ?? 0),
    totalUsers: Number(row?.total_users ?? 0),
    activeUsers30d: Number(row?.active_users_30d ?? 0),
  };
}

export type RunsPerDayPoint = {
  date: string;
  succeeded: number;
  failed: number;
  running: number;
  rowsProcessed: number;
};

/** Cross-org daily run counts (ok vs. failed vs. still-running) + rows processed, grouped by UTC calendar day over the trailing `days` window. */
export async function getRunsPerDay(db: Queryable, days = 30): Promise<RunsPerDayPoint[]> {
  const result = await db.query<{
    day: string;
    succeeded: string;
    failed: string;
    running: string;
    rows_processed: string | null;
  }>(
    `select
       to_char(date_trunc('day', r.started_at), 'YYYY-MM-DD') as day,
       count(*) filter (where r.status = 'succeeded') as succeeded,
       count(*) filter (where r.status = 'failed') as failed,
       count(*) filter (where r.status = 'running') as running,
       sum(r.rows_processed) as rows_processed
     from public.workflow_runs r
     where r.started_at > now() - ($1 || ' days')::interval
     group by 1
     order by 1`,
    [days],
  );

  return result.rows.map((row) => ({
    date: row.day,
    succeeded: Number(row.succeeded),
    failed: Number(row.failed),
    running: Number(row.running),
    rowsProcessed: Number(row.rows_processed ?? 0),
  }));
}

export type RowsMovedTotals = {
  allTime: number;
  last30d: number;
};

/** Cross-org rows-moved totals — all-time and trailing 30 days. */
export async function getRowsMovedTotals(db: Queryable): Promise<RowsMovedTotals> {
  const result = await db.query<{ all_time: string | null; last_30d: string | null }>(
    `select
       sum(rows_processed) as all_time,
       sum(rows_processed) filter (where started_at > now() - interval '30 days') as last_30d
     from public.workflow_runs`,
  );

  const row = result.rows[0];
  return {
    allTime: Number(row?.all_time ?? 0),
    last30d: Number(row?.last_30d ?? 0),
  };
}

export type NeedsAttentionReason = "suspended" | "near_limit" | "failing_runs";

export type NeedsAttentionItem = {
  orgId: string;
  orgName: string;
  reason: NeedsAttentionReason;
  detail: string;
};

/**
 * Three independent lists, each capped at `limit`, concatenated:
 *  - suspended: currently-suspended orgs, most recently suspended first.
 *  - near_limit: non-suspended orgs at >= 80% of their effective workflow
 *    limit (orgs with no limit, i.e. unlimited, never qualify). Reuses the
 *    same `case when op.workflow_limit_set then ... else pl.workflow_limit
 *    end` effective-limit expression as GET /console/orgs/:orgId.
 *  - failing_runs: non-suspended orgs with the most failed runs in the
 *    trailing 7 days (a suspended org's failures aren't actionable the same
 *    way, so it's excluded here to avoid double-listing it alongside its
 *    own "suspended" entry).
 * A single org can appear under more than one reason — that's intentional,
 * each row is its own actionable signal, not a deduplicated org list.
 */
export async function getNeedsAttention(db: Queryable, limit = 10): Promise<NeedsAttentionItem[]> {
  const [suspended, nearLimit, failingRuns] = await Promise.all([
    db.query<{ id: string; name: string; suspended_reason: string | null }>(
      `select id, name, suspended_reason
       from public.organizations
       where suspended_at is not null
       order by suspended_at desc
       limit $1`,
      [limit],
    ),
    db.query<{ id: string; name: string; workflow_count: number; workflow_limit: number }>(
      `with limits as (
         select
           o.id,
           o.name,
           count(w.id)::int as workflow_count,
           case when op.workflow_limit_set then op.workflow_limit else pl.workflow_limit end as workflow_limit
         from public.organizations o
         join public.org_plan op on op.org_id = o.id
         join public.plans pl on pl.id = op.plan_id
         left join public.workflows w on w.org_id = o.id
         where o.suspended_at is null
         group by o.id, o.name, op.workflow_limit_set, op.workflow_limit, pl.workflow_limit
       )
       select id, name, workflow_count, workflow_limit
       from limits
       where workflow_limit is not null and workflow_count >= 0.8 * workflow_limit
       order by workflow_count desc
       limit $1`,
      [limit],
    ),
    db.query<{ id: string; name: string; failed_count: number }>(
      `select o.id, o.name, count(r.id)::int as failed_count
       from public.organizations o
       join public.workflow_runs r on r.org_id = o.id
       where r.status = 'failed'
         and r.started_at > now() - interval '7 days'
         and o.suspended_at is null
       group by o.id, o.name
       order by count(r.id) desc
       limit $1`,
      [limit],
    ),
  ]);

  const items: NeedsAttentionItem[] = [];
  for (const row of suspended.rows) {
    items.push({ orgId: row.id, orgName: row.name, reason: "suspended", detail: row.suspended_reason ?? "Suspended" });
  }
  for (const row of nearLimit.rows) {
    items.push({
      orgId: row.id,
      orgName: row.name,
      reason: "near_limit",
      detail: `${row.workflow_count}/${row.workflow_limit} workflows`,
    });
  }
  for (const row of failingRuns.rows) {
    items.push({
      orgId: row.id,
      orgName: row.name,
      reason: "failing_runs",
      detail: `${row.failed_count} failed run${row.failed_count === 1 ? "" : "s"} in the last 7 days`,
    });
  }
  return items;
}
