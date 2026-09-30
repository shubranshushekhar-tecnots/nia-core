-- 0059_write_grants_admin_owner_only.sql
-- Subscription Phase 2, Slice 5: restrict write-grant minting/confirming/
-- revoking to org admin/owner, reversing "Phase 6 Block 1: write-grant
-- RBAC — kept all-role" (docs/decisions.md). See that doc's slice 5 entry
-- for the full history/reasoning.
--
-- The write_grants RPCs swap their org-scoped authorization check to
-- private.is_admin (role in ('admin', 'owner') — pre-existing helper,
-- 0004_owner_rename.sql, unchanged by this migration). The
-- personal-workspace branch (v_owner_id = auth.uid()) is untouched: a
-- personal workspace has no admin/owner distinction, so its sole member
-- keeps full access to their own connections' grants.
--
-- create_write_grant and revoke_write_grant are single functions, last
-- touched by 0057_viewer_role_restrictions.sql (private.is_write_member);
-- bodies here are byte-for-byte identical to 0057's, only the auth helper
-- changes.
--
-- confirm_write_grant is overloaded (2-arg from 0016, 3-arg from 0028) and
-- needed a closer look — see that section below for what was actually
-- found and why both overloads are touched here, not just the 3-arg one.

-- --- create_write_grant ---------------------------------------------------
-- Before (0057_viewer_role_restrictions.sql:299-340), authorization check
-- was:
--   if not (
--     (v_org_id is not null and private.is_write_member(v_org_id))
--     or (v_owner_id is not null and v_owner_id = auth.uid())
--   ) then
create or replace function public.create_write_grant(p_connection_id uuid, p_scope jsonb)
returns public.write_grants
language plpgsql
security definer
set search_path = pg_catalog, public
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
    (v_org_id is not null and private.is_admin(v_org_id))
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

-- --- confirm_write_grant (3-arg overload; the one apps/api actually calls,
--     always with all 3 params — see apps/api/src/services/grants.ts:178)
-- -----------------------------------------------------------------------
-- confirm_write_grant is overloaded: 0016_write_grants.sql created a 2-arg
-- form (p_grant_id, p_write_credential_vault_ref), then
-- 0028_write_grant_role_name.sql added this 3-arg form with the extra
-- p_write_role_name param. 0057_viewer_role_restrictions.sql only
-- `create or replace`d the 2-arg overload (private.is_member ->
-- private.is_write_member) — it never touched this 3-arg overload, which
-- was still running 0028's original private.is_member(v_org_id) check
-- (i.e. any org member including viewer) right up until this migration.
-- Since production only ever calls the 3-arg form, that gap meant a
-- viewer could confirm a write grant despite 0057's stated intent. This
-- migration closes it directly to private.is_admin. Signature/default and
-- audit jsonb are otherwise reproduced exactly from 0028.
create or replace function public.confirm_write_grant(
  p_grant_id uuid,
  p_write_credential_vault_ref text,
  p_write_role_name text default null
)
returns public.write_grants
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_connection_id uuid;
  v_org_id uuid;
  v_owner_id uuid;
  v_next_cred_version integer;
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
    (v_org_id is not null and private.is_admin(v_org_id))
    or (v_owner_id is not null and v_owner_id = auth.uid())
  ) then
    raise exception 'not authorized for connection %', v_connection_id;
  end if;

  select coalesce(max(cred_version), 0) + 1 into v_next_cred_version
  from public.write_grants
  where connection_id = v_connection_id;

  update public.write_grants
    set confirmed_at = now(),
        write_credential_vault_ref = p_write_credential_vault_ref,
        write_role_name = p_write_role_name,
        cred_version = v_next_cred_version
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
    jsonb_build_object('connectionId', v_connection_id, 'grantId', p_grant_id, 'credVersion', v_next_cred_version)
  );

  return v_row;
end;
$$;

-- --- confirm_write_grant (2-arg overload; dead code — no caller in this
--     codebase passes only 2 args — but still `grant execute`d to
--     `authenticated` since 0016, so it remains a reachable RPC surface.
--     Closed here for defense-in-depth so no confirm_write_grant overload
--     is left checking anything looser than private.is_admin.)
-- -----------------------------------------------------------------------
create or replace function public.confirm_write_grant(p_grant_id uuid, p_write_credential_vault_ref text)
returns public.write_grants
language plpgsql
security definer
set search_path = pg_catalog, public
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
    (v_org_id is not null and private.is_admin(v_org_id))
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
-- Before (0057_viewer_role_restrictions.sql:398-446), authorization check
-- was the same private.is_write_member(v_org_id) shape as above.
create or replace function public.revoke_write_grant(p_grant_id uuid)
returns public.write_grants
language plpgsql
security definer
set search_path = pg_catalog, public
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
    (v_org_id is not null and private.is_admin(v_org_id))
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
