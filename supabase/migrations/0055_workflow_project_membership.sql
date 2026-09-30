-- 0055_workflow_project_membership.sql
-- Subscription Phase 2 follow-up (docs/plans/subscription-model.md build
-- order step 2): 0054_project_members.sql scoped its own tightened RLS to
-- `public.projects` only, deliberately leaving `workflows`/`workflow_runs`
-- for "a future slice" (see that migration's header comment). This is that
-- slice: the same "member needs private.is_admin(org_id) OR
-- private.is_project_member(...)" rule 0054 added to projects_select/
-- update/delete_members is extended to workflows' select/insert/update/
-- delete policies and to workflow_runs' select policy (its only
-- authenticated-facing policy — inserts/updates/deletes stay
-- service_role-only, untouched). Personal (owner_id) rows are unaffected,
-- same as 0054: the owner_id branch of every policy below is untouched.
--
-- workflows has its own project_id column already (0002_projects_workflows.sql),
-- so its policies call private.is_project_member(project_id) directly —
-- no new helper needed there. workflow_runs only has workflow_id (no
-- project_id — see that table's header comment on org_id being
-- denormalized for RLS, not project_id), so a new
-- private.is_workflow_project_member(p_workflow) helper joins
-- workflows -> project_members the same way 0054's
-- private.can_manage_project joins projects, for the same "avoid a policy
-- referencing another table's RLS-guarded rows directly" reason.
--
-- Every recreated policy is shown immediately after its current
-- (0046_org_suspension.sql for insert/update/delete; 0005_individual_
-- workspace.sql, untouched since, for select) text for an easy
-- side-by-side diff, same discipline as 0054.

-- =========================================================================
-- 1. private.is_workflow_project_member(p_workflow) — workflow_runs has no
--    project_id column of its own; this maps workflow_id -> project_id ->
--    project_members the same way private.is_project_member(p_project)
--    checks a project_id directly.
-- =========================================================================

create or replace function private.is_workflow_project_member(p_workflow uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.workflows w
    join public.project_members pm on pm.project_id = w.project_id
    where w.id = p_workflow and pm.user_id = auth.uid()
  );
$$;

revoke execute on function private.is_workflow_project_member(uuid) from public, anon, authenticated;
grant execute on function private.is_workflow_project_member(uuid) to authenticated;

-- =========================================================================
-- 2. workflows — tighten select/insert/update/delete for the org-scoped
--    branch only (personal/owner_id branch untouched throughout).
-- =========================================================================

-- --- workflows_select_members ------------------------------------------
-- Before (0005_individual_workspace.sql:86-92, untouched since):
--   using (
--     (org_id is not null and private.is_member(org_id))
--     or (org_id is null and owner_id = auth.uid())
--   );
drop policy "workflows_select_members" on public.workflows;
create policy "workflows_select_members"
  on public.workflows for select
  using (
    (org_id is not null and private.is_member(org_id) and (private.is_admin(org_id) or private.is_project_member(project_id)))
    or (org_id is null and owner_id = auth.uid())
  );

-- --- workflows_insert_members --------------------------------------------
-- Before (0046_org_suspension.sql:148-157):
--   with check (
--     created_by = auth.uid()
--     and (
--       (org_id is not null and owner_id is null and private.is_member(org_id) and not private.is_org_suspended(org_id))
--       or (org_id is null and owner_id = auth.uid())
--     )
--   );
drop policy "workflows_insert_members" on public.workflows;
create policy "workflows_insert_members"
  on public.workflows for insert
  with check (
    created_by = auth.uid()
    and (
      (org_id is not null and owner_id is null and private.is_member(org_id) and not private.is_org_suspended(org_id) and (private.is_admin(org_id) or private.is_project_member(project_id)))
      or (org_id is null and owner_id = auth.uid())
    )
  );

-- --- workflows_update_members --------------------------------------------
-- Before (0046_org_suspension.sql:169-179):
--   using (
--     (org_id is not null and private.is_member(org_id) and not private.is_org_suspended(org_id))
--     or (org_id is null and owner_id = auth.uid())
--   )
--   with check (
--     (org_id is not null and private.is_member(org_id) and not private.is_org_suspended(org_id))
--     or (org_id is null and owner_id = auth.uid())
--   );
drop policy "workflows_update_members" on public.workflows;
create policy "workflows_update_members"
  on public.workflows for update
  using (
    (org_id is not null and private.is_member(org_id) and not private.is_org_suspended(org_id) and (private.is_admin(org_id) or private.is_project_member(project_id)))
    or (org_id is null and owner_id = auth.uid())
  )
  with check (
    (org_id is not null and private.is_member(org_id) and not private.is_org_suspended(org_id) and (private.is_admin(org_id) or private.is_project_member(project_id)))
    or (org_id is null and owner_id = auth.uid())
  );

-- --- workflows_delete_members --------------------------------------------
-- Before (0046_org_suspension.sql:187-193):
--   using (
--     (org_id is not null and private.is_member(org_id) and not private.is_org_suspended(org_id))
--     or (org_id is null and owner_id = auth.uid())
--   );
drop policy "workflows_delete_members" on public.workflows;
create policy "workflows_delete_members"
  on public.workflows for delete
  using (
    (org_id is not null and private.is_member(org_id) and not private.is_org_suspended(org_id) and (private.is_admin(org_id) or private.is_project_member(project_id)))
    or (org_id is null and owner_id = auth.uid())
  );

-- =========================================================================
-- 3. workflow_runs — select only (system-authored, no client writes; see
--    0002_projects_workflows.sql's own header comment on that table).
-- =========================================================================

-- --- workflow_runs_select_members ----------------------------------------
-- Before (0005_individual_workspace.sql:138-144, untouched since):
--   using (
--     (org_id is not null and private.is_member(org_id))
--     or (org_id is null and owner_id = auth.uid())
--   );
drop policy "workflow_runs_select_members" on public.workflow_runs;
create policy "workflow_runs_select_members"
  on public.workflow_runs for select
  using (
    (org_id is not null and private.is_member(org_id) and (private.is_admin(org_id) or private.is_workflow_project_member(workflow_id)))
    or (org_id is null and owner_id = auth.uid())
  );
