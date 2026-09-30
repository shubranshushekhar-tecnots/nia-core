-- 0061_billing_owner.sql
-- Subscription Phase 4, Slice 1 (docs/plans/subscription-model.md's
-- payments build order step 1): organizations.billing_owner_id — exactly
-- one billing owner per org, always a current org owner, transferable only
-- via the transfer_billing_owner() RPC below (never a direct column
-- UPDATE — see the column-level REVOKE at the bottom). Personal
-- workspaces need no equivalent column: owner_plan.user_id (0051) already
-- is the sole billing owner for that scope. Resolves the TODO.md note left
-- by Slice 7 (removed in this same change).

alter table public.organizations
  add column billing_owner_id uuid references public."user" (id);

comment on column public.organizations.billing_owner_id is
  'The org owner who manages billing/payments. Exactly one per org, always'
  ' a current organization_members role=owner row. Set automatically on'
  ' org creation (see the trigger below); changed only via'
  ' transfer_billing_owner(), never a direct column UPDATE (see the'
  ' column-level REVOKE at the bottom of this file).';

-- =========================================================================
-- 1. Default billing_owner_id to created_by on insert
-- =========================================================================
-- Runs on every insert into organizations, whether through
-- create_organization() or a direct insert (e.g. rls_probes.sql's
-- fixtures) — matches organizations.created_by's own provenance shape
-- (0035_better_auth.sql). Does not itself validate that created_by is (or
-- will become) an 'owner' membership row: at INSERT time no
-- organization_members rows exist yet for a brand-new org (the owner
-- membership row is always inserted in a second statement right after,
-- same transaction — see create_organization() below), so there is
-- nothing to check against yet. If created_by is null (the 0035 orphan
-- case), billing_owner_id is simply left null — an org with no known
-- creator has no assignable billing owner either.

create or replace function private.default_billing_owner()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.billing_owner_id is null then
    new.billing_owner_id := new.created_by;
  end if;
  return new;
end;
$$;

revoke execute on function private.default_billing_owner() from public, anon, authenticated;

create trigger organizations_default_billing_owner
  before insert on public.organizations
  for each row execute function private.default_billing_owner();

-- =========================================================================
-- 2. Backfill existing orgs
-- =========================================================================
-- Prefers created_by when that user currently holds role='owner' in the
-- org (the common case); otherwise falls back to that org's
-- lowest-user_id current owner (deterministic). An org with zero owner
-- rows (shouldn't exist — protect_last_super_admin, 0004_owner_rename.sql,
-- has guaranteed at least one owner per org since that migration ran —
-- but this makes no assumption) is left with billing_owner_id null and
-- reported via notice for manual follow-up; the NOT NULL constraint below
-- is applied conditionally for exactly this reason.

update public.organizations o
set billing_owner_id = o.created_by
where o.billing_owner_id is null
  and o.created_by is not null
  and exists (
    select 1 from public.organization_members m
    where m.org_id = o.id and m.user_id = o.created_by and m.role = 'owner'
  );

update public.organizations o
set billing_owner_id = (
  select m.user_id from public.organization_members m
  where m.org_id = o.id and m.role = 'owner'
  order by m.user_id
  limit 1
)
where o.billing_owner_id is null;

do $$
declare
  v_count integer;
begin
  select count(*) into v_count from public.organizations where billing_owner_id is null;
  if v_count > 0 then
    raise notice '0061_billing_owner: % organization(s) have no owner membership row and were left with billing_owner_id null — needs manual Console follow-up before NOT NULL can be applied to those rows', v_count;
  else
    alter table public.organizations alter column billing_owner_id set not null;
  end if;
end $$;

-- =========================================================================
-- 3. create_organization() — set the creator as billing owner explicitly
-- =========================================================================
-- Redundant with the trigger above in the common case (created_by is
-- already auth.uid()) but stated explicitly here so this function reads
-- correctly on its own, matching every prior create_organization()
-- revision's style (0001/0004).

create or replace function public.create_organization(p_name text, p_slug text)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  new_org_id uuid;
begin
  insert into public.organizations (name, slug, created_by, billing_owner_id)
  values (p_name, p_slug, auth.uid(), auth.uid())
  returning id into new_org_id;

  insert into public.organization_members (org_id, user_id, role)
  values (new_org_id, auth.uid(), 'owner');

  perform private.log_audit(new_org_id, 'organization.created', jsonb_build_object('name', p_name, 'slug', p_slug));

  return new_org_id;
end;
$$;

-- =========================================================================
-- 4. Protect the billing owner from removal/demotion while still billing
--    owner — same trigger as protect_last_super_admin (0004_owner_rename.sql),
--    extended rather than duplicated (trigger already points at this
--    function by name — no need to touch the trigger itself).
-- =========================================================================
-- Before (0004_owner_rename.sql:89-117): only guarded against removing
-- the org's last owner. This adds a second, independent guard: whoever
-- currently holds organizations.billing_owner_id can never be demoted
-- away from 'owner' or removed from the org at all, regardless of how
-- many other owners exist — billing ownership must be explicitly
-- transferred first (transfer_billing_owner(), below).

create or replace function private.protect_last_super_admin()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  remaining int;
  target_org uuid;
  v_billing_owner uuid;
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

    select billing_owner_id into v_billing_owner from public.organizations where id = target_org;
    if v_billing_owner = old.user_id then
      raise exception 'Cannot remove or demote the billing owner — transfer billing ownership first';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- =========================================================================
-- 5. transfer_billing_owner() RPC — atomic, self-service, current billing
--    owner only. This is the concrete implementation of the
--    "org.transferOwnership" capability already declared (but unused)
--    in packages/schemas/src/can.ts.
-- =========================================================================
-- The target must already hold role='owner' in the org (mirrors
-- billing_owner_id's own invariant — never a non-owner). Only the current
-- billing owner may initiate a transfer; there is deliberately no
-- admin/owner override in this slice (an org that has lost access to its
-- billing owner's account is a support/Console escalation, not a
-- self-service path — same posture as the last-owner protection above,
-- which also has no self-service override).

create or replace function public.transfer_billing_owner(p_org uuid, p_new_billing_owner uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_current_billing_owner uuid;
  v_new_role public.org_role;
begin
  select billing_owner_id into v_current_billing_owner
  from public.organizations
  where id = p_org;

  if v_current_billing_owner is null then
    raise exception 'organization % not found', p_org;
  end if;

  if auth.uid() <> v_current_billing_owner then
    raise exception 'only the current billing owner can transfer billing ownership';
  end if;

  select role into v_new_role
  from public.organization_members
  where org_id = p_org and user_id = p_new_billing_owner;

  if v_new_role is null or v_new_role <> 'owner' then
    raise exception 'the new billing owner must already be an owner of this organization';
  end if;

  update public.organizations
  set billing_owner_id = p_new_billing_owner
  where id = p_org;

  perform private.log_audit(
    p_org,
    'billing.ownerTransferred',
    jsonb_build_object('from', v_current_billing_owner, 'to', p_new_billing_owner)
  );
end;
$$;

revoke execute on function public.transfer_billing_owner(uuid, uuid) from public, anon, authenticated;
grant execute on function public.transfer_billing_owner(uuid, uuid) to authenticated;

-- =========================================================================
-- 6. Column-level lock: billing_owner_id is never client-writable except
--    through transfer_billing_owner() above, even though
--    organizations_update_admins (0001_auth_orgs.sql) otherwise lets any
--    admin/owner UPDATE the row. A plain `revoke update (billing_owner_id)`
--    would be a no-op here: authenticated already holds table-level UPDATE
--    (granted once, covering every column) from 0001_auth_orgs.sql, and a
--    column-level REVOKE only strips a column-level GRANT — it cannot
--    narrow a table-level one. So this drops the table-level UPDATE grant
--    entirely and re-grants it column-by-column, omitting billing_owner_id.
-- =========================================================================

revoke update on public.organizations from authenticated;
grant update (name, slug, created_by, created_at, suspended_at, suspended_by, suspended_reason)
  on public.organizations to authenticated;
