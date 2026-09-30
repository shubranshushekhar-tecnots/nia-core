-- 0057_viewer_role_restrictions.sql
-- Subscription Phase 2, Slice 3 ("Viewer role"), Migration B. 0056 alone
-- added the 'viewer' enum value (its own transaction, per Postgres's
-- add-then-use rule for enums); this migration is everything that actually
-- references it.
--
-- Viewer is read-only: can SELECT projects/workflows/workflow_runs of
-- projects they're added to (via project_members, same gate as any other
-- non-admin role — see 0054/0055) and org connections, but cannot
-- INSERT/UPDATE/DELETE anything, and cannot start or cancel a run.
--
-- Every SELECT policy across every table in this migration's scope is
-- LEFT UNTOUCHED — viewer must keep exactly the same read access as a plain
-- member (`private.is_member` already includes viewer; there is no
-- role-based narrowing needed for reads). Only the org-scoped branch of
-- every INSERT/UPDATE/DELETE policy, and the three write_grants RPCs plus
-- cancel_workflow_run, are changed to additionally exclude viewer.
--
-- Chosen mechanism: a new private.is_write_member(p_org) helper — mirrors
-- private.is_member's exact shape (0001_auth_orgs.sql:115-126) but adds
-- `role <> 'viewer'` — swapped in for private.is_member(org_id) in every
-- write-side check below. private.is_member itself is NOT changed (reads
-- must still include viewer), and every table's own SELECT policy is
-- likewise untouched.
--
-- workflow_runs has zero authenticated-facing INSERT/UPDATE/DELETE RLS
-- policies at all (system-authored only, see 0002's header comment) — so
-- "viewer cannot start or cancel a run" is enforced at the API layer only
-- (packages/schemas/src/can.ts's CAPABILITY_MATRIX omits viewer from
-- workflows.run; apps/api/src/middleware/requireCapability.ts is what
-- actually 403s a viewer's POST /:id/run or /:id/run/cancel — see
-- apps/api/src/routes/runs.ts, both gated by requireCapability
-- ("workflows.run")). cancel_workflow_run's own RPC-level check is
-- nonetheless tightened below too, for defense-in-depth consistency with
-- CONVENTIONS.md's "RLS/DB is the real trust boundary, can.ts is
-- convenience only" — the API-layer gate must never be the only thing
-- stopping a viewer from cancelling a run they could otherwise reach
-- directly through the RPC.
--
-- project_members policies (0054, gated by private.can_manage_project =
-- admin/owner of org or the personal owner) and organization_members
-- policies (0001/0004, gated by private.is_admin) are UNCHANGED — viewer
-- can never be admin/owner/personal-owner, so it's already excluded from
-- managing either. org_plan_select_members (0044) is likewise UNCHANGED —
-- read-only, viewer should read it same as any other member.

-- =========================================================================
-- 1. private.is_write_member(p_org) — mirrors private.is_member's exact
--    shape (0001_auth_orgs.sql:115-126), plus excluding viewer.
-- =========================================================================

create or replace function private.is_write_member(p_org uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_members
    where org_id = p_org and user_id = auth.uid() and role <> 'viewer'
  );
$$;

revoke execute on function private.is_write_member(uuid) from public, anon, authenticated;
grant execute on function private.is_write_member(uuid) to authenticated;

-- =========================================================================
-- 2. projects — swap is_member -> is_write_member in insert/update/delete
--    (select is untouched). Current (0054_project_members.sql) text shown
--    immediately before each replacement for an easy side-by-side diff.
-- =========================================================================

-- --- projects_insert_members -------------------------------------------
-- Before (0046_org_suspension.sql:87-96 — untouched by 0054, which only
-- amended select/update/delete):
--   with check (
--     created_by = auth.uid()
--     and (
--       (org_id is not null and owner_id is null and private.is_member(org_id) and not private.is_org_suspended(org_id))
--       or (org_id is null and owner_id = auth.uid())
--     )
--   );
drop policy "projects_insert_members" on public.projects;
create policy "projects_insert_members"
  on public.projects for insert
  with check (
    created_by = auth.uid()
    and (
      (org_id is not null and owner_id is null and private.is_write_member(org_id) and not private.is_org_suspended(org_id))
      or (org_id is null and owner_id = auth.uid())
    )
  );

-- --- projects_update_members -------------------------------------------
-- Before (0054_project_members.sql:201-211):
--   using (
--     (org_id is not null and private.is_member(org_id) and not private.is_org_suspended(org_id) and (private.is_admin(org_id) or private.is_project_member(id)))
--     or (org_id is null and owner_id = auth.uid())
--   )
--   with check (
--     (org_id is not null and private.is_member(org_id) and not private.is_org_suspended(org_id) and (private.is_admin(org_id) or private.is_project_member(id)))
--     or (org_id is null and owner_id = auth.uid())
--   );
drop policy "projects_update_members" on public.projects;
create policy "projects_update_members"
  on public.projects for update
  using (
    (org_id is not null and private.is_write_member(org_id) and not private.is_org_suspended(org_id) and (private.is_admin(org_id) or private.is_project_member(id)))
    or (org_id is null and owner_id = auth.uid())
  )
  with check (
    (org_id is not null and private.is_write_member(org_id) and not private.is_org_suspended(org_id) and (private.is_admin(org_id) or private.is_project_member(id)))
    or (org_id is null and owner_id = auth.uid())
  );

-- --- projects_delete_members -------------------------------------------
-- Before (0054_project_members.sql:219-225):
--   using (
--     (org_id is not null and private.is_member(org_id) and not private.is_org_suspended(org_id) and (private.is_admin(org_id) or private.is_project_member(id)))
--     or (org_id is null and owner_id = auth.uid())
--   );
drop policy "projects_delete_members" on public.projects;
create policy "projects_delete_members"
  on public.projects for delete
  using (
    (org_id is not null and private.is_write_member(org_id) and not private.is_org_suspended(org_id) and (private.is_admin(org_id) or private.is_project_member(id)))
    or (org_id is null and owner_id = auth.uid())
  );

-- =========================================================================
-- 3. workflows — same shape as projects. Current
--    (0055_workflow_project_membership.sql) text shown before each
--    replacement.
-- =========================================================================

-- --- workflows_insert_members --------------------------------------------
-- Before (0055_workflow_project_membership.sql):
--   with check (
--     created_by = auth.uid()
--     and (
--       (org_id is not null and owner_id is null and private.is_member(org_id) and not private.is_org_suspended(org_id) and (private.is_admin(org_id) or private.is_project_member(project_id)))
--       or (org_id is null and owner_id = auth.uid())
--     )
--   );
drop policy "workflows_insert_members" on public.workflows;
create policy "workflows_insert_members"
  on public.workflows for insert
  with check (
    created_by = auth.uid()
    and (
      (org_id is not null and owner_id is null and private.is_write_member(org_id) and not private.is_org_suspended(org_id) and (private.is_admin(org_id) or private.is_project_member(project_id)))
      or (org_id is null and owner_id = auth.uid())
    )
  );

-- --- workflows_update_members --------------------------------------------
-- Before (0055_workflow_project_membership.sql):
--   using (
--     (org_id is not null and private.is_member(org_id) and not private.is_org_suspended(org_id) and (private.is_admin(org_id) or private.is_project_member(project_id)))
--     or (org_id is null and owner_id = auth.uid())
--   )
--   with check (same shape);
drop policy "workflows_update_members" on public.workflows;
create policy "workflows_update_members"
  on public.workflows for update
  using (
    (org_id is not null and private.is_write_member(org_id) and not private.is_org_suspended(org_id) and (private.is_admin(org_id) or private.is_project_member(project_id)))
    or (org_id is null and owner_id = auth.uid())
  )
  with check (
    (org_id is not null and private.is_write_member(org_id) and not private.is_org_suspended(org_id) and (private.is_admin(org_id) or private.is_project_member(project_id)))
    or (org_id is null and owner_id = auth.uid())
  );

-- --- workflows_delete_members --------------------------------------------
-- Before (0055_workflow_project_membership.sql):
--   using (
--     (org_id is not null and private.is_member(org_id) and not private.is_org_suspended(org_id) and (private.is_admin(org_id) or private.is_project_member(project_id)))
--     or (org_id is null and owner_id = auth.uid())
--   );
drop policy "workflows_delete_members" on public.workflows;
create policy "workflows_delete_members"
  on public.workflows for delete
  using (
    (org_id is not null and private.is_write_member(org_id) and not private.is_org_suspended(org_id) and (private.is_admin(org_id) or private.is_project_member(project_id)))
    or (org_id is null and owner_id = auth.uid())
  );

-- =========================================================================
-- 4. connections — Before (0007_connectors.sql:143-171), select untouched.
-- =========================================================================

-- --- connections_insert_members -------------------------------------------
-- Before:
--   with check (
--     owner_user_id = auth.uid()
--     and (
--       (org_id is not null and owner_id is null and private.is_member(org_id))
--       or (org_id is null and owner_id = auth.uid())
--     )
--   );
drop policy "connections_insert_members" on public.connections;
create policy "connections_insert_members"
  on public.connections for insert
  with check (
    owner_user_id = auth.uid()
    and (
      (org_id is not null and owner_id is null and private.is_write_member(org_id))
      or (org_id is null and owner_id = auth.uid())
    )
  );

-- --- connections_update_members -------------------------------------------
-- Before:
--   using (
--     (org_id is not null and private.is_member(org_id))
--     or (org_id is null and owner_id = auth.uid())
--   )
--   with check (same shape);
drop policy "connections_update_members" on public.connections;
create policy "connections_update_members"
  on public.connections for update
  using (
    (org_id is not null and private.is_write_member(org_id))
    or (org_id is null and owner_id = auth.uid())
  )
  with check (
    (org_id is not null and private.is_write_member(org_id))
    or (org_id is null and owner_id = auth.uid())
  );

-- --- connections_delete_members -------------------------------------------
-- Before:
--   using (
--     (org_id is not null and private.is_member(org_id))
--     or (org_id is null and owner_id = auth.uid())
--   );
drop policy "connections_delete_members" on public.connections;
create policy "connections_delete_members"
  on public.connections for delete
  using (
    (org_id is not null and private.is_write_member(org_id))
    or (org_id is null and owner_id = auth.uid())
  );

-- =========================================================================
-- 5. connector_installs — Before (0007_connectors.sql:60-79), select
--    untouched (no update policy exists on this table).
-- =========================================================================

-- --- connector_installs_insert_members -------------------------------------
-- Before:
--   with check (
--     installed_by_user_id = auth.uid()
--     and (
--       (org_id is not null and owner_id is null and private.is_member(org_id))
--       or (org_id is null and owner_id = auth.uid())
--     )
--   );
drop policy "connector_installs_insert_members" on public.connector_installs;
create policy "connector_installs_insert_members"
  on public.connector_installs for insert
  with check (
    installed_by_user_id = auth.uid()
    and (
      (org_id is not null and owner_id is null and private.is_write_member(org_id))
      or (org_id is null and owner_id = auth.uid())
    )
  );

-- --- connector_installs_delete_members -------------------------------------
-- Before:
--   using (
--     (org_id is not null and private.is_member(org_id))
--     or (org_id is null and owner_id = auth.uid())
--   );
drop policy "connector_installs_delete_members" on public.connector_installs;
create policy "connector_installs_delete_members"
  on public.connector_installs for delete
  using (
    (org_id is not null and private.is_write_member(org_id))
    or (org_id is null and owner_id = auth.uid())
  );

-- =========================================================================
-- 6. write_grants RPCs (0016_write_grants.sql) — swap is_member ->
--    is_write_member in each function's authorization check. Bodies are
--    otherwise byte-for-byte identical to 0016's versions; only the
--    `create or replace` re-declares them.
-- =========================================================================

-- --- create_write_grant ---------------------------------------------------
-- Before (0016_write_grants.sql:88-129), authorization check was:
--   if not (
--     (v_org_id is not null and private.is_member(v_org_id))
--     or (v_owner_id is not null and v_owner_id = auth.uid())
--   ) then
create or replace function public.create_write_grant(p_connection_id uuid, p_scope jsonb)
returns public.write_grants
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_owner_id uuid;
  v_row public.write_grants;
begin
  select org_id, owner_id into v_org_id, v_owner_id
  from public.connections
  where id = p_connection_id;

  if v_org_id is null and v_owner_id is null then
    raise exception 'connection % not found', p_connection_id;
  end if;

  if not (
    (v_org_id is not null and private.is_write_member(v_org_id))
    or (v_owner_id is not null and v_owner_id = auth.uid())
  ) then
    raise exception 'not authorized for connection %', p_connection_id;
  end if;

  insert into public.write_grants (connection_id, granted_by_user_id, scope)
  values (p_connection_id, auth.uid(), coalesce(p_scope, '{}'::jsonb))
  returning * into v_row;

  insert into public.audit_log (org_id, owner_id, actor, action, detail)
  values (
    v_org_id,
    v_owner_id,
    auth.uid(),
    'write_grant.created',
    jsonb_build_object('connectionId', p_connection_id, 'grantId', v_row.id, 'scope', v_row.scope)
  );

  return v_row;
end;
$$;

-- --- confirm_write_grant ---------------------------------------------------
-- Before (0016_write_grants.sql:140-188), authorization check was the same
-- private.is_member(v_org_id) shape as above.
create or replace function public.confirm_write_grant(p_grant_id uuid, p_write_credential_vault_ref text)
returns public.write_grants
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection_id uuid;
  v_org_id uuid;
  v_owner_id uuid;
  v_row public.write_grants;
begin
  select connection_id into v_connection_id from public.write_grants where id = p_grant_id;
  if v_connection_id is null then
    raise exception 'write grant % not found', p_grant_id;
  end if;

  select org_id, owner_id into v_org_id, v_owner_id
  from public.connections
  where id = v_connection_id;

  if not (
    (v_org_id is not null and private.is_write_member(v_org_id))
    or (v_owner_id is not null and v_owner_id = auth.uid())
  ) then
    raise exception 'not authorized for connection %', v_connection_id;
  end if;

  update public.write_grants
    set confirmed_at = now(), write_credential_vault_ref = p_write_credential_vault_ref
    where id = p_grant_id and confirmed_at is null and revoked_at is null
    returning * into v_row;

  if v_row.id is null then
    raise exception 'write grant % is already confirmed or has been revoked', p_grant_id;
  end if;

  insert into public.audit_log (org_id, owner_id, actor, action, detail)
  values (
    v_org_id,
    v_owner_id,
    auth.uid(),
    'write_grant.confirmed',
    jsonb_build_object('connectionId', v_connection_id, 'grantId', p_grant_id)
  );

  return v_row;
end;
$$;

-- --- revoke_write_grant ---------------------------------------------------
-- Before (0016_write_grants.sql:197-245), authorization check was the same
-- private.is_member(v_org_id) shape as above.
create or replace function public.revoke_write_grant(p_grant_id uuid)
returns public.write_grants
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection_id uuid;
  v_org_id uuid;
  v_owner_id uuid;
  v_row public.write_grants;
begin
  select connection_id into v_connection_id from public.write_grants where id = p_grant_id;
  if v_connection_id is null then
    raise exception 'write grant % not found', p_grant_id;
  end if;

  select org_id, owner_id into v_org_id, v_owner_id
  from public.connections
  where id = v_connection_id;

  if not (
    (v_org_id is not null and private.is_write_member(v_org_id))
    or (v_owner_id is not null and v_owner_id = auth.uid())
  ) then
    raise exception 'not authorized for connection %', v_connection_id;
  end if;

  update public.write_grants
    set revoked_at = now()
    where id = p_grant_id and revoked_at is null
    returning * into v_row;

  if v_row.id is null then
    raise exception 'write grant % is already revoked', p_grant_id;
  end if;

  insert into public.audit_log (org_id, owner_id, actor, action, detail)
  values (
    v_org_id,
    v_owner_id,
    auth.uid(),
    'write_grant.revoked',
    jsonb_build_object('connectionId', v_connection_id, 'grantId', p_grant_id)
  );

  return v_row;
end;
$$;

-- =========================================================================
-- 7. cancel_workflow_run (0017_run_checkpoints.sql) — defense-in-depth
--    only; the primary "viewer can't cancel a run" gate is
--    requireCapability("workflows.run") at the API layer (see this file's
--    header comment). Before: `if not private.is_member(v_org_id) then`.
-- =========================================================================

create or replace function public.cancel_workflow_run(p_run_id uuid)
returns public.workflow_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_row public.workflow_runs;
begin
  select org_id into v_org_id from public.workflow_runs where id = p_run_id;
  if v_org_id is null then
    raise exception 'workflow run % not found', p_run_id;
  end if;

  if not private.is_write_member(v_org_id) then
    raise exception 'not authorized for workflow run %', p_run_id;
  end if;

  update public.workflow_runs
    set status = 'cancelled'
    where id = p_run_id and status = 'running'
    returning * into v_row;

  if v_row.id is null then
    raise exception 'workflow run % is not running (already finished or cancelled)', p_run_id;
  end if;

  insert into public.audit_log (org_id, actor, action, detail)
  values (v_org_id, auth.uid(), 'workflow_run.cancelled', jsonb_build_object('runId', p_run_id));

  return v_row;
end;
$$;
