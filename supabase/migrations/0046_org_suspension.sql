-- 0046_org_suspension.sql
-- Console v1 Slice 3b (docs/plans/console-plan.md, build order step 9):
-- POST /console/orgs/:orgId/suspend + /unsuspend. Two independent pieces:
--
-- 1. `organizations` suspension columns — the data the console routes
--    read/write via `withServiceRole` (no RLS change needed for the
--    columns themselves; `organizations_select_members`,
--    0001_auth_orgs.sql:165, already covers them for members).
--
-- 2. `private.is_org_suspended(org_id)` — a boolean helper mirroring
--    `private.is_member`'s exact shape (0001_auth_orgs.sql:115-126:
--    `security definer stable set search_path = ''`, revoked from
--    public/anon/authenticated, granted to authenticated only) — plus an
--    amended `with check`/`using` clause on every RLS policy that lets
--    `authenticated` (i.e. apps/web's `withActingUser` direct-write path,
--    NOT apps/api, which is gated separately in `attachActor`) insert,
--    update, or delete an org-scoped row in `public.projects` or
--    `public.workflows` — the only two tables apps/web writes directly
--    (audited exhaustively for this migration; every other client write —
--    connections, connectors, grants, chat, workflow_graphs, copilot
--    plans — goes through apps/api, which is covered by the attachActor
--    check added in the same build step, not by RLS here).
--
--    Chosen over a new BEFORE INSERT/UPDATE/DELETE trigger (the pattern
--    0045_workflow_plan_enforcement.sql used for workflow_limit): that
--    trigger exists because a plain `count(*)` check has a genuine
--    concurrency race a trigger's advisory lock solves; "is this org
--    suspended" is a plain boolean with no such race, so extending the
--    RLS policies that already gate every one of these writes is the
--    more idiomatic choice per CONVENTIONS.md's own "RLS is the only
--    trust boundary" rule — one mechanism, not two.
--
--    Only the org-scoped branch of each policy's OR is touched;
--    personally-owned rows (org_id is null, owner_id set — no
--    organization to suspend) are completely unaffected. DELETE is
--    included per decision: suspended = frozen (no destructive OR
--    additive writes at all while suspended), unlike 0045's trigger
--    (which only ever fires on INSERT).
--
-- Every recreated policy is shown immediately after its pre-0046 text
-- (as it stands after 0005_individual_workspace.sql, the last migration
-- to touch these six policies) for an easy side-by-side diff.

-- =========================================================================
-- 1. organizations — suspension columns
-- =========================================================================

alter table public.organizations
  add column suspended_at     timestamptz,
  add column suspended_by     uuid references public.user (id),
  add column suspended_reason text;

-- =========================================================================
-- 2. private.is_org_suspended(org_id) — mirrors private.is_member's exact
--    shape (0001_auth_orgs.sql:115-126).
-- =========================================================================

create or replace function private.is_org_suspended(p_org uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.organizations
    where id = p_org and suspended_at is not null
  );
$$;

revoke execute on function private.is_org_suspended(uuid) from public, anon, authenticated;
grant execute on function private.is_org_suspended(uuid) to authenticated;

-- =========================================================================
-- 3. projects — amend insert/update/delete policies
-- =========================================================================

-- --- projects_insert_members --------------------------------------------
-- Before (0005_individual_workspace.sql:42-50):
--   with check (
--     created_by = auth.uid()
--     and (
--       (org_id is not null and owner_id is null and private.is_member(org_id))
--       or (org_id is null and owner_id = auth.uid())
--     )
--   );
drop policy "projects_insert_members" on public.projects;
create policy "projects_insert_members"
  on public.projects for insert
  with check (
    created_by = auth.uid()
    and (
      (org_id is not null and owner_id is null and private.is_member(org_id) and not private.is_org_suspended(org_id))
      or (org_id is null and owner_id = auth.uid())
    )
  );

-- --- projects_update_members --------------------------------------------
-- Before (0005_individual_workspace.sql:53-63):
--   using (
--     (org_id is not null and private.is_member(org_id))
--     or (org_id is null and owner_id = auth.uid())
--   )
--   with check (
--     (org_id is not null and private.is_member(org_id))
--     or (org_id is null and owner_id = auth.uid())
--   );
drop policy "projects_update_members" on public.projects;
create policy "projects_update_members"
  on public.projects for update
  using (
    (org_id is not null and private.is_member(org_id) and not private.is_org_suspended(org_id))
    or (org_id is null and owner_id = auth.uid())
  )
  with check (
    (org_id is not null and private.is_member(org_id) and not private.is_org_suspended(org_id))
    or (org_id is null and owner_id = auth.uid())
  );

-- --- projects_delete_members --------------------------------------------
-- Before (0005_individual_workspace.sql:65-72):
--   using (
--     (org_id is not null and private.is_member(org_id))
--     or (org_id is null and owner_id = auth.uid())
--   );
drop policy "projects_delete_members" on public.projects;
create policy "projects_delete_members"
  on public.projects for delete
  using (
    (org_id is not null and private.is_member(org_id) and not private.is_org_suspended(org_id))
    or (org_id is null and owner_id = auth.uid())
  );

-- =========================================================================
-- 4. workflows — amend insert/update/delete policies (same shape as
--    projects above)
-- =========================================================================

-- --- workflows_insert_members --------------------------------------------
-- Before (0005_individual_workspace.sql:94-104):
--   with check (
--     created_by = auth.uid()
--     and (
--       (org_id is not null and owner_id is null and private.is_member(org_id))
--       or (org_id is null and owner_id = auth.uid())
--     )
--   );
drop policy "workflows_insert_members" on public.workflows;
create policy "workflows_insert_members"
  on public.workflows for insert
  with check (
    created_by = auth.uid()
    and (
      (org_id is not null and owner_id is null and private.is_member(org_id) and not private.is_org_suspended(org_id))
      or (org_id is null and owner_id = auth.uid())
    )
  );

-- --- workflows_update_members --------------------------------------------
-- Before (0005_individual_workspace.sql:105-115):
--   using (
--     (org_id is not null and private.is_member(org_id))
--     or (org_id is null and owner_id = auth.uid())
--   )
--   with check (
--     (org_id is not null and private.is_member(org_id))
--     or (org_id is null and owner_id = auth.uid())
--   );
drop policy "workflows_update_members" on public.workflows;
create policy "workflows_update_members"
  on public.workflows for update
  using (
    (org_id is not null and private.is_member(org_id) and not private.is_org_suspended(org_id))
    or (org_id is null and owner_id = auth.uid())
  )
  with check (
    (org_id is not null and private.is_member(org_id) and not private.is_org_suspended(org_id))
    or (org_id is null and owner_id = auth.uid())
  );

-- --- workflows_delete_members --------------------------------------------
-- Before (0005_individual_workspace.sql:117-124):
--   using (
--     (org_id is not null and private.is_member(org_id))
--     or (org_id is null and owner_id = auth.uid())
--   );
drop policy "workflows_delete_members" on public.workflows;
create policy "workflows_delete_members"
  on public.workflows for delete
  using (
    (org_id is not null and private.is_member(org_id) and not private.is_org_suspended(org_id))
    or (org_id is null and owner_id = auth.uid())
  );
