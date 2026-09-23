-- 0018_write_grant_cred_version_bump.sql
-- Phase 6 Block 5 fast-pass follow-up: closes the gap 0016_write_grants.sql's
-- own column comment already flagged ("[cred_version] Not incremented by
-- this migration's functions ... but modeled as a real column now so Block
-- 2's write connector pool cache key (connectionId:write:credVersion) has
-- something to read from day one").
--
-- Found live during Block 5's write-smoke-mysql-mongo.ts run: reusing a
-- connection (revoke + re-create a write grant on the same connection_id,
-- which 0016's header comment documents as the supported rotation path)
-- left every grant confirmed with cred_version staying at its column
-- default of 1. That means the connector's write pool cache key
-- (connectionId:write:credVersion) never changes across a rotation, so a
-- connector service can keep serving a pooled client authenticated under
-- the *previous* write credential — observed as connector-mongodb
-- returning "Command update requires authentication" (code 13) on the
-- second confirmed grant for the same connection, because MongoDB
-- invalidates a live session's auth when the underlying user is
-- dropped+recreated server-side, but the connector's in-memory pool cache
-- had no way to know that and kept reusing the old client.
--
-- Fix: confirm_write_grant now sets cred_version to one past the highest
-- cred_version already used by any grant on that connection, instead of
-- relying on the column default. Every confirmed grant on a connection
-- therefore gets a strictly increasing cred_version, guaranteeing a fresh
-- write-pool cache key per rotation regardless of connector dialect or
-- DB-specific session-invalidation behavior. Additive-only: no column or
-- table change, only the function body (same convention as 0016 itself
-- replacing 0007's functions).

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
