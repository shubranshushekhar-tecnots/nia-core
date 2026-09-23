-- 0028_write_grant_role_name.sql
-- Phase 6 Block 5 follow-up (manual E2E fix chain, item 1): confirm_write_grant
-- previously stored only an opaque write_credential_vault_ref for the pasted
-- write-role credential — the role/user name itself (e.g. "nia_write_a1b2c3d4",
-- generated client-side by NodeDrawer.tsx's randomWriteRoleUser) was never
-- persisted anywhere retrievable, only known transiently inside
-- GrantAccessPanel's component state. That made two things impossible once the
-- confirming session ended (component remount, page reload, or the panel
-- unmounting the instant grantCovers flips true and SourceDestForm swaps in
-- RevokeAccessPanel): (a) showing the role name / re-displaying the DDL
-- afterwards, and (b) building the DROP ROLE/DROP USER SQL a connection's
-- delete flow should offer for each of its confirmed write grants.
--
-- Fix: store the role/user name — non-secret, it's an identifier, not a
-- credential — alongside the vault ref. confirm_write_grant's signature grows
-- a p_write_role_name param, defaulted to null so the many existing
-- apps/worker/scripts/*-smoke.ts callers (named-arg RPC calls that only ever
-- pass p_grant_id/p_write_credential_vault_ref) keep working unchanged;
-- apps/api/src/services/grants.ts (the only caller that has a role name to
-- give) passes it explicitly. The old 2-arg overload is dropped in the same
-- migration rather than left dangling.

alter table public.write_grants add column write_role_name text;

comment on column public.write_grants.write_role_name is
  'Non-secret role/user identifier for the write credential (e.g. "nia_write_a1b2c3d4"), '
  'set by confirm_write_grant(). Used only for UI display (persistent DDL/role reminder) '
  'and to build DROP ROLE/DROP USER SQL on connection delete — never the credential '
  'itself, which stays in Vault via write_credential_vault_ref.';

drop function if exists public.confirm_write_grant(uuid, text);

create or replace function public.confirm_write_grant(
  p_grant_id uuid,
  p_write_credential_vault_ref text,
  p_write_role_name text default null
)
returns public.write_grants
language plpgsql
security definer
set search_path = ''
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
    (v_org_id is not null and private.is_member(v_org_id))
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

revoke execute on function public.confirm_write_grant(uuid, text, text) from public, anon;
grant execute on function public.confirm_write_grant(uuid, text, text) to authenticated;
