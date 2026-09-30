-- 0067_announcements.sql
-- Subscription Phase 5 (Console additions), decision 1: in-app announcements
-- (no email — no email service exists, see docs/plans/subscription-model.md's
-- "Super admin" section). Two tables:
--
--   1. public.announcements — one row per announcement. Targeting is a
--      three-way discriminated union on `audience` (all | org | project),
--      enforced by the CHECK below rather than three nullable FKs with no
--      constraint tying them to `audience` — mirrors the tri-state shape
--      org_plan's own columns already use elsewhere in this codebase.
--      `audience_roles` (org_role[]) is an optional further narrowing, only
--      meaningful for audience='org' (a project has no per-member role to
--      filter on, and 'all' has no single org's roles to check against) —
--      the CHECK enforces that too. Staff-write-only: no INSERT/UPDATE/
--      DELETE policy for `authenticated` at all (same posture as
--      `org_plan`/`invite_links`), everything mutates through the Console
--      API's `withServiceRole` connection, gated by `requireStaff`.
--
--   2. public.announcement_dismissals — per-user, append-only (no delete/
--      update policy: "dismissed" is a permanent fact for that user/
--      announcement pair, nothing to undo). The INSERT policy's WITH CHECK
--      does double duty: the `exists (select 1 from announcements ...)`
--      subquery is itself evaluated under `announcements`' own SELECT RLS
--      (`announcements_select_targeted` below), so a user can only insert a
--      dismissal for an announcement that is BOTH currently active/targeted
--      at them AND not `severity = 'critical'` — decision 1's "critical
--      stays until ends_at or archived" requirement, enforced at the DB
--      layer, not just the app's banner UI. No separate "is this still
--      active" check is needed once ended/archived: an inactive
--      announcement already stops matching `announcements_select_targeted`,
--      so the app's own "active, undismissed" query naturally stops
--      rendering it regardless of whether a dismissal row exists.

-- =========================================================================
-- 1. public.announcements
-- =========================================================================

create type public.announcement_severity as enum ('info', 'warning', 'critical');
create type public.announcement_audience as enum ('all', 'org', 'project');

create table public.announcements (
  id                 uuid primary key default gen_random_uuid(),
  title              text not null check (length(trim(title)) > 0 and length(title) <= 200),
  body               text not null check (length(trim(body)) > 0 and length(body) <= 5000),
  severity           public.announcement_severity not null default 'info',
  audience           public.announcement_audience not null,
  audience_org_id     uuid references public.organizations (id) on delete cascade,
  audience_project_id uuid references public.projects (id) on delete cascade,
  audience_roles     public.org_role[],
  starts_at          timestamptz not null default now(),
  ends_at            timestamptz,
  created_by         uuid not null references public."user" (id),
  archived_at        timestamptz,
  created_at         timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at),
  check (
    (audience = 'all' and audience_org_id is null and audience_project_id is null and audience_roles is null)
    or (audience = 'org' and audience_org_id is not null and audience_project_id is null)
    or (audience = 'project' and audience_project_id is not null and audience_org_id is null and audience_roles is null)
  )
);

comment on table public.announcements is
  'Staff-authored in-app announcements (Subscription Phase 5, decision 1). '
  'Written only via the Console API (service_role) — no client INSERT/'
  'UPDATE/DELETE grant. See announcements_select_targeted for the visibility '
  'rule authenticated users are scoped by.';

comment on column public.announcements.audience_roles is
  'Optional further narrowing within an org audience, e.g. owners+admins '
  'only (Subscription Phase 5, decision 2''s staff-removal notice). Null = '
  'every member of the target org/project regardless of role. Always null '
  'for audience in (''all'', ''project'') — enforced by this table''s CHECK.';

comment on column public.announcements.severity is
  'info/warning are user-dismissible (announcement_dismissals); critical '
  'is not — announcement_dismissals_insert_own''s WITH CHECK rejects a '
  'dismissal row for any currently-active critical announcement.';

create index announcements_audience_org_id_idx
  on public.announcements (audience_org_id) where audience_org_id is not null;

create index announcements_audience_project_id_idx
  on public.announcements (audience_project_id) where audience_project_id is not null;

create index announcements_active_idx
  on public.announcements (starts_at, ends_at) where archived_at is null;

alter table public.announcements enable row level security;

-- Visible only while active (started, not yet ended, not archived) AND
-- targeted at the caller: every 'all' row, an 'org' row for a member of
-- that org (further narrowed by audience_roles if set, via
-- private.org_role — 0001_auth_orgs.sql), or a 'project' row for a member
-- of that project (private.is_project_member — 0054_project_members.sql).
create policy "announcements_select_targeted"
  on public.announcements for select
  using (
    archived_at is null
    and starts_at <= now()
    and (ends_at is null or ends_at > now())
    and (
      audience = 'all'
      or (
        audience = 'org'
        and private.is_member(audience_org_id)
        and (audience_roles is null or private.org_role(audience_org_id) = any(audience_roles))
      )
      or (audience = 'project' and private.is_project_member(audience_project_id))
    )
  );

-- No insert/update/delete policy for authenticated: staff-only, via
-- withServiceRole in the Console API. service_role bypasses RLS entirely
-- (same as every other staff-write table in this schema).
revoke insert, update, delete on public.announcements from authenticated;
grant select on public.announcements to authenticated;

-- =========================================================================
-- 2. public.announcement_dismissals
-- =========================================================================

create table public.announcement_dismissals (
  announcement_id uuid not null references public.announcements (id) on delete cascade,
  user_id         uuid not null references public."user" (id) on delete cascade,
  dismissed_at    timestamptz not null default now(),
  primary key (announcement_id, user_id)
);

create index announcement_dismissals_user_id_idx
  on public.announcement_dismissals (user_id);

alter table public.announcement_dismissals enable row level security;

create policy "announcement_dismissals_select_own"
  on public.announcement_dismissals for select
  using (user_id = auth.uid());

-- See header comment: the exists() subquery is itself RLS-scoped by
-- announcements_select_targeted, so this also implicitly requires the
-- announcement to be currently active and targeted at the caller, on top
-- of the explicit severity <> 'critical' check.
create policy "announcement_dismissals_insert_own"
  on public.announcement_dismissals for insert
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.announcements a
      where a.id = announcement_id and a.severity <> 'critical'
    )
  );

-- No update/delete policy: a dismissal is a permanent, append-only fact
-- for that (announcement, user) pair.
grant select, insert on public.announcement_dismissals to authenticated;
