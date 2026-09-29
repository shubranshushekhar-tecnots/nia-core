-- 0051_owner_plan_table.sql
-- Subscription model Phase 1, build order step 3: personal-workspace
-- (owner_id-scoped, no org) equivalent of org_plan (0042/0050) — same
-- plan_id + override-flag columns, RLS restricted to the owning user only
-- (writes are Console/service_role only, same as org_plan).
--
-- Signup today only ever inserts into public."user" (0035_better_auth.sql:48
-- — signUpEmail creates no org and no separate "personal workspace" row),
-- so that's the only hook point for defaulting a brand-new individual to
-- Free. Existing users are backfilled to plan_id='legacy' with no
-- overrides, same reasoning as 0050's org_plan backfill: a later
-- Legacy->Pro change must actually raise their effective limit.

create table public.owner_plan (
  user_id             uuid primary key references public."user"(id) on delete cascade,
  plan_id             text not null references public.plans(id),
  workflow_limit      integer,
  workflow_limit_set  boolean not null default false,
  project_limit       integer,
  project_limit_set   boolean not null default false,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references public."user"(id)
);

comment on table public.owner_plan is
  'Personal-workspace (owner_id-scoped, no org) equivalent of org_plan. One row per user. RLS: owner can select own row only; writes are Console/service_role only.';
comment on column public.owner_plan.workflow_limit_set is
  'true = workflow_limit (however set, including null) overrides plans.workflow_limit; false = inherit the plan''s limit.';
comment on column public.owner_plan.project_limit_set is
  'true = project_limit (however set, including null) overrides plans.project_limit; false = inherit the plan''s limit.';

alter table public.owner_plan enable row level security;

grant select on public.owner_plan to authenticated;

create policy "owner_plan_select_own"
  on public.owner_plan for select
  to authenticated
  using (user_id = auth.uid());

-- Backfill: one row per existing user, no overrides (inherits legacy's
-- 25 workflows / unlimited projects, same shape as 0050's org_plan backfill).
insert into public.owner_plan (user_id, plan_id, workflow_limit_set, project_limit_set)
select id, 'legacy', false, false
from public."user"
on conflict (user_id) do nothing;

-- New signups default to Free going forward (existing users stay on Legacy,
-- untouched by the backfill above). SECURITY DEFINER with a pinned
-- search_path and fully-qualified names since this fires on every insert
-- into public."user", not from a narrow, trusted call site — same shape as
-- 0043_org_plan.sql's private.set_default_org_plan().
create or replace function private.set_default_owner_plan()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.owner_plan (user_id, plan_id)
  values (new.id, 'free')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

revoke execute on function private.set_default_owner_plan() from public, anon, authenticated;

create trigger set_default_owner_plan_trigger
  after insert on public."user"
  for each row execute function private.set_default_owner_plan();
