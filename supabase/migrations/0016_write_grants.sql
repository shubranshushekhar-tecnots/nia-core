-- 0016_write_grants.sql
-- Phase 6 Block 1: hardens the write_grants table 0007_connectors.sql
-- already shipped (as an unexercised placeholder, ahead of any real write
-- connector) into the real two-step grant/confirm/revoke data model.
--
-- Additive/reversible, same convention as 0005/0009/0014: no column is
-- dropped or renamed. Three new nullable-or-defaulted columns
-- (confirmed_at, cred_version, write_credential_vault_ref) are added to
-- the existing table rather than creating a new one. `granted_at`
-- (0007) already covers the kickoff spec's "created_at" field — same
-- concept, existing name kept rather than renamed in place.
--
-- RBAC ruling (see docs/decisions.md, "Phase 6 Block 1: write-grant RBAC —
-- kept all-role, matching DECISION-C"): create/confirm/revoke stay
-- all-role (individual/member/admin/owner), NOT admin/owner-restricted —
-- this migration does not gate by org_role at all, only by workspace
-- membership (private.is_member / owner_id = auth.uid()), exactly the
-- same access test 0007's own write_grants policies already used.
--
-- What DOES change from 0007: write_grants becomes RPC-only for writes.
-- 0007 granted authenticated direct INSERT/UPDATE under RLS (any member
-- could mint or edit a grant with a bare PostgREST call); a write grant is
-- now an attestation with real consequences (Block 2's connector /write
-- path treats a confirmed, unrevoked grant as sufficient to unlock a
-- write verb) — same "forgeable gate" reasoning 0014_workflow_check_runs.sql
-- already applied to workflow_check_runs. The three SECURITY DEFINER
-- functions below are the only write path from here on; direct client
-- INSERT/UPDATE is revoked at both the RLS-policy and table-grant layers
-- (belt-and-suspenders, matching 0014's approach).
--
-- Two-step confirm is deliberate (kickoff spec): create_write_grant
-- records the requested scope; confirm_write_grant is a second, explicit
-- call that also records the write credential's Vault ref
-- (write_credential_vault_ref) — the actual CREATE ROLE/GRANT statements
-- happen on the customer's own database, out-of-band, per the kickoff's
-- "we generate and show the statements, we never execute DDL on their DB"
-- constraint; this migration only models the resulting vault reference on
-- the grant row. Rotation is not supported by re-confirming an existing
-- row (confirm_write_grant raises if already confirmed) — to rotate a
-- write credential, revoke the grant and create a new one, keeping the
-- append-only/audit-trail shape 0007's header comment already committed
-- to ("revocation = set revoked_at, never delete").

-- =========================================================================
-- 1. Schema: three new columns
-- =========================================================================

alter table public.write_grants add column confirmed_at timestamptz;
alter table public.write_grants add column cred_version integer not null default 1;
alter table public.write_grants add column write_credential_vault_ref text;

comment on column public.write_grants.confirmed_at is
  'Set only by confirm_write_grant() once the write credential exists. A '
  'grant with confirmed_at null is "requested, not yet usable" — Block 2''s '
  'connector /write path and checkGrants (Block 2) both require confirmed_at '
  'is not null and revoked_at is null before a write verb unlocks.';

comment on column public.write_grants.cred_version is
  'The WRITE credential''s own version, independent of the connection''s '
  'read-side cred_version (public.connections.cred_version) — bumping one '
  'never bumps the other, since they are different Vault secrets/DB roles '
  'entirely. Not incremented by this migration''s functions (rotation is '
  'revoke + re-create, per this file''s header comment), but modeled as a '
  'real column now so Block 2''s write connector pool cache key '
  '(connectionId:write:credVersion, per the kickoff spec) has something to '
  'read from day one.';

comment on column public.write_grants.write_credential_vault_ref is
  'Vault secret reference for the write credential, set by confirm_write_grant(). '
  'Null until confirmed. Never the connection''s own read-side vault_secret_ref.';

-- =========================================================================
-- 2. RLS: revoke direct client writes (RPC-only from here on)
-- =========================================================================

drop policy "write_grants_insert_members" on public.write_grants;
drop policy "write_grants_update_members" on public.write_grants;

-- write_grants_select_members (0007) is unchanged — select via workspace
-- access on the parent connection stays exactly as it was.

revoke insert, update on public.write_grants from authenticated;

-- =========================================================================
-- 3. create_write_grant — records a requested grant (unconfirmed)
-- =========================================================================

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
    (v_org_id is not null and private.is_member(v_org_id))
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

revoke execute on function public.create_write_grant(uuid, jsonb) from public, anon;
grant execute on function public.create_write_grant(uuid, jsonb) to authenticated;

-- =========================================================================
-- 4. confirm_write_grant — the second step: attaches the write credential
-- =========================================================================
-- Fails (no row updated) if the grant is already confirmed or already
-- revoked — deliberately not idempotent, see header comment on rotation.

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
    (v_org_id is not null and private.is_member(v_org_id))
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

revoke execute on function public.confirm_write_grant(uuid, text) from public, anon;
grant execute on function public.confirm_write_grant(uuid, text) to authenticated;

-- =========================================================================
-- 5. revoke_write_grant — soft-delete, never a row delete
-- =========================================================================

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
    (v_org_id is not null and private.is_member(v_org_id))
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

revoke execute on function public.revoke_write_grant(uuid) from public, anon;
grant execute on function public.revoke_write_grant(uuid) to authenticated;
