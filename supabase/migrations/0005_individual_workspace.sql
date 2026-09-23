-- 0005_individual_workspace.sql
-- Adds support for "individual" users — people with no organization at
-- all, working in their own personal workspace (DECISION-D in the role
-- overhaul plan). Reuses the existing projects/workflows/workflow_runs
-- tables rather than introducing a parallel table family: org_id becomes
-- nullable, and a new owner_id column carries personal ownership. Exactly
-- one of (org_id, owner_id) must be set on every row, enforced by a check
-- constraint — a row is either org-scoped or personally-owned, never both
-- and never neither.
--
-- Additive/reversible: no existing column is dropped or renamed, no
-- existing row's org_id is touched (all pre-existing rows already satisfy
-- "org_id is not null" so they trivially satisfy the new check
-- constraint), and every RLS policy recreated below still grants exactly
-- the same access to org-scoped rows as before — it only adds a second,
-- independent OR-branch for personally-owned rows. Rollback: drop the
-- three check constraints, drop the three owner_id columns, recreate the
-- policies below with the personal-ownership OR-branch removed, and set
-- org_id back to not null on all three tables.

-- =========================================================================
-- 1. projects
-- =========================================================================

alter table public.projects alter column org_id drop not null;
alter table public.projects add column owner_id uuid references auth.users (id);

alter table public.projects add constraint projects_org_xor_owner check (
  (org_id is not null and owner_id is null) or (org_id is null and owner_id is not null)
);

create index projects_owner_id_idx on public.projects (owner_id);

drop policy "projects_select_members" on public.projects;
create policy "projects_select_members"
  on public.projects for select
  using (
    (org_id is not null and private.is_member(org_id))
    or (org_id is null and owner_id = auth.uid())
  );

drop policy "projects_insert_members" on public.projects;
create policy "projects_insert_members"
  on public.projects for insert
  with check (
    created_by = auth.uid()
    and (
      (org_id is not null and owner_id is null and private.is_member(org_id))
      or (org_id is null and owner_id = auth.uid())
    )
  );

drop policy "projects_update_members" on public.projects;
create policy "projects_update_members"
  on public.projects for update
  using (
    (org_id is not null and private.is_member(org_id))
    or (org_id is null and owner_id = auth.uid())
  )
  with check (
    (org_id is not null and private.is_member(org_id))
    or (org_id is null and owner_id = auth.uid())
  );

drop policy "projects_delete_members" on public.projects;
create policy "projects_delete_members"
  on public.projects for delete
  using (
    (org_id is not null and private.is_member(org_id))
    or (org_id is null and owner_id = auth.uid())
  );

-- =========================================================================
-- 2. workflows
-- =========================================================================

alter table public.workflows alter column org_id drop not null;
alter table public.workflows add column owner_id uuid references auth.users (id);

alter table public.workflows add constraint workflows_org_xor_owner check (
  (org_id is not null and owner_id is null) or (org_id is null and owner_id is not null)
);

create index workflows_owner_id_updated_at_idx on public.workflows (owner_id, updated_at desc);

drop policy "workflows_select_members" on public.workflows;
create policy "workflows_select_members"
  on public.workflows for select
  using (
    (org_id is not null and private.is_member(org_id))
    or (org_id is null and owner_id = auth.uid())
  );

drop policy "workflows_insert_members" on public.workflows;
create policy "workflows_insert_members"
  on public.workflows for insert
  with check (
    created_by = auth.uid()
    and (
      (org_id is not null and owner_id is null and private.is_member(org_id))
      or (org_id is null and owner_id = auth.uid())
    )
  );

drop policy "workflows_update_members" on public.workflows;
create policy "workflows_update_members"
  on public.workflows for update
  using (
    (org_id is not null and private.is_member(org_id))
    or (org_id is null and owner_id = auth.uid())
  )
  with check (
    (org_id is not null and private.is_member(org_id))
    or (org_id is null and owner_id = auth.uid())
  );

drop policy "workflows_delete_members" on public.workflows;
create policy "workflows_delete_members"
  on public.workflows for delete
  using (
    (org_id is not null and private.is_member(org_id))
    or (org_id is null and owner_id = auth.uid())
  );

-- =========================================================================
-- 3. workflow_runs — still system-authored (service_role only), select-only
-- =========================================================================

alter table public.workflow_runs alter column org_id drop not null;
alter table public.workflow_runs add column owner_id uuid references auth.users (id);

alter table public.workflow_runs add constraint workflow_runs_org_xor_owner check (
  (org_id is not null and owner_id is null) or (org_id is null and owner_id is not null)
);

create index workflow_runs_owner_id_started_at_idx on public.workflow_runs (owner_id, started_at desc);

drop policy "workflow_runs_select_members" on public.workflow_runs;
create policy "workflow_runs_select_members"
  on public.workflow_runs for select
  using (
    (org_id is not null and private.is_member(org_id))
    or (org_id is null and owner_id = auth.uid())
  );
