-- 0004_owner_rename.sql
-- Renames the customer-facing top org role from `super_admin` to `owner`.
-- Depends on 0003_owner_enum_value.sql having already committed the new
-- 'owner' enum value in a prior transaction.
--
-- Why: the org role model is being extended with a separate internal
-- "Nia Console" staff realm whose top role is called `superadmin`. Reusing
-- the name `super_admin` for the customer-facing top role would collide
-- with that realm, so the customer role is renamed to `owner` (which is
-- also the term the product spec uses for "full billing + org control,
-- can promote/demote other owners").
--
-- This is additive/reversible, per project migration discipline:
--   - Postgres cannot cheaply drop an enum value, so 'super_admin' stays
--     defined on public.org_role (unused after this migration) rather than
--     being removed.
--   - Every existing 'super_admin' membership row is backfilled to 'owner'.
--   - Every RLS policy/helper/trigger that compared against 'super_admin'
--     is recreated (drop + create, or create-or-replace for functions) to
--     compare against 'owner' instead. Behavior is unchanged — this is a
--     pure rename, not a permission change.
--
-- Rollback (down-migration, not applied automatically): backfill 'owner'
-- membership rows back to 'super_admin', then recreate the policies/
-- functions below with 'owner' swapped back to 'super_admin'. No data is
-- lost in either direction since both enum values remain valid.

-- =========================================================================
-- 1. Helpers (private schema) — recreate to reference 'owner'
-- =========================================================================

create or replace function private.is_admin(p_org uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_members
    where org_id = p_org
      and user_id = auth.uid()
      and role in ('admin', 'owner')
  );
$$;

-- private.is_member and private.org_role do not reference the role name
-- literal at all — no change needed there.

-- =========================================================================
-- 2. organization_members policies — recreate to reference 'owner'
-- =========================================================================

drop policy "members_insert_admins" on public.organization_members;
create policy "members_insert_admins"
  on public.organization_members for insert
  with check (
    private.is_admin(org_id)
    and (role <> 'owner' or private.org_role(org_id) = 'owner')
  );

drop policy "members_update_admins" on public.organization_members;
create policy "members_update_admins"
  on public.organization_members for update
  using (
    private.is_admin(org_id)
    and (role <> 'owner' or private.org_role(org_id) = 'owner')
  )
  with check (
    private.is_admin(org_id)
    and (role <> 'owner' or private.org_role(org_id) = 'owner')
  );

drop policy "members_delete_admins_or_self" on public.organization_members;
create policy "members_delete_admins_or_self"
  on public.organization_members for delete
  using (
    user_id = auth.uid()  -- leaving the org yourself is always allowed
    or (
      private.is_admin(org_id)
      and (role <> 'owner' or private.org_role(org_id) = 'owner')
    )
  );

-- =========================================================================
-- 3. Last-owner protection trigger — recreate to reference 'owner'
-- =========================================================================

create or replace function private.protect_last_super_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  remaining int;
  target_org uuid;
begin
  target_org := coalesce(old.org_id, new.org_id);

  if (tg_op = 'DELETE' and old.role = 'owner')
     or (tg_op = 'UPDATE' and old.role = 'owner' and new.role <> 'owner') then
    select count(*) into remaining
    from public.organization_members
    where org_id = target_org and role = 'owner' and user_id <> old.user_id;

    if remaining = 0 then
      raise exception 'Cannot remove or demote the last owner of an organization';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- Trigger itself already points at this function by name — no need to
-- drop/recreate the trigger, only the function body changed.

-- =========================================================================
-- 4. Backfill existing membership rows
-- =========================================================================

update public.organization_members set role = 'owner' where role = 'super_admin';

-- =========================================================================
-- 5. create_organization RPC — new orgs are created with an 'owner' row
-- =========================================================================

create or replace function public.create_organization(p_name text, p_slug text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_org_id uuid;
begin
  insert into public.organizations (name, slug, created_by)
  values (p_name, p_slug, auth.uid())
  returning id into new_org_id;

  insert into public.organization_members (org_id, user_id, role)
  values (new_org_id, auth.uid(), 'owner');

  perform private.log_audit(new_org_id, 'organization.created', jsonb_build_object('name', p_name, 'slug', p_slug));

  return new_org_id;
end;
$$;

-- Note: public.organizations_update_admins and public.audit_log_select_admins
-- policies already key off private.is_admin(), which was redefined in
-- step 1 above — no separate policy rewrite needed for those two.
