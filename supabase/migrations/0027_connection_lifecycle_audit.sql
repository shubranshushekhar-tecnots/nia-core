-- 0027_connection_lifecycle_audit.sql
-- Connection edit/delete lifecycle: secret-merge RPCs + a generic
-- connection-audit RPC, same "public-schema SECURITY DEFINER wrapper"
-- shape as 0008/0009.
--
-- Why merge_connector_secret/delete_connector_secret exist at all: apps/api
-- deliberately holds no service_role key (0009's header comment), and
-- resolve_connector_secret (0008) is service_role-only by design — so
-- apps/api can never decrypt an existing vault secret to merge a partial
-- edit (e.g. "keep the stored password, just change host") itself. Doing
-- the decrypt+merge+re-encrypt entirely inside Postgres, as `authenticated`,
-- keeps that guarantee intact: apps/api only ever sees vault_secret_ref
-- values (opaque uuids), never plaintext credentials, for edits exactly as
-- it already does for creates (create_connector_secret) and dispatch
-- (resolve_connector_secret, called by the connector services, not apps/api).
--
-- Same "no table access, so nothing here for RLS to gate" reasoning as
-- create_connector_secret: any authenticated user may merge/delete a vault
-- secret by ref, but a ref is only useful if it's already referenced by an
-- RLS-protected connections row that caller can read/write — same trust
-- boundary as create_connector_secret's own comment describes.

-- =========================================================================
-- 1. merge_connector_secret — decrypt-merge-reencrypt, never exposing
--    plaintext outside this function.
-- =========================================================================
-- Mirrors resolve_connector_secret's direct vault.decrypted_secrets query
-- (0008) rather than calling it, since that RPC is service_role-only and
-- this one must be callable by `authenticated`. Shallow jsonb merge
-- (`existing || partial`) — p_partial only carries fields the caller
-- actually wants to change; omitted/blank secret fields are simply absent
-- from p_partial, so the merge naturally keeps the stored value.

create or replace function public.merge_connector_secret(p_old_ref uuid, p_partial jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing text;
  v_merged jsonb;
  v_new_id uuid;
begin
  select decrypted_secret into v_existing
  from vault.decrypted_secrets
  where id = p_old_ref;

  if v_existing is null then
    raise exception 'vault secret not found for ref %', p_old_ref;
  end if;

  v_merged := v_existing::jsonb || coalesce(p_partial, '{}'::jsonb);
  v_new_id := vault.create_secret(v_merged::text);
  return v_new_id;
end;
$$;

revoke execute on function public.merge_connector_secret(uuid, jsonb) from public, anon;
grant execute on function public.merge_connector_secret(uuid, jsonb) to authenticated;

-- =========================================================================
-- 2. delete_connector_secret — cleanup for a newly-minted secret when the
--    post-mint dispatchTest (in updateConnection's edit flow) fails, so a
--    rejected edit doesn't leak an orphaned vault row.
-- =========================================================================

create or replace function public.delete_connector_secret(p_ref uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform vault.delete_secret(p_ref);
end;
$$;

revoke execute on function public.delete_connector_secret(uuid) from public, anon;
grant execute on function public.delete_connector_secret(uuid) to authenticated;

-- =========================================================================
-- 3. log_connection_audit — generic connection-lifecycle audit insert.
-- =========================================================================
-- log_execution_audit (0009) hard-codes action = 'connection.execute' and
-- is purpose-built for the dispatch/query path. This is the same
-- org/owner-lookup + service_role-vs-authenticated actor-resolution shape,
-- but with a free-text p_action so it can record connection.deleted,
-- connection.schema_refreshed, and connection.updated (detail carries only
-- field *names* for connection.updated — see updateConnection — never
-- values, same "no secrets in audit_log" rule log_execution_audit follows).

create or replace function public.log_connection_audit(
  p_connection_id uuid,
  p_action text,
  p_detail jsonb,
  p_actor_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_org_id uuid;
  v_owner_id uuid;
  v_caller_role text := current_setting('role', true);
begin
  if v_caller_role = 'service_role' then
    if p_actor_user_id is null then
      raise exception 'p_actor_user_id is required for service_role callers';
    end if;
    v_actor := p_actor_user_id;
  else
    v_actor := auth.uid();
    if v_actor is null then
      raise exception 'not authenticated';
    end if;
  end if;

  select org_id, owner_id into v_org_id, v_owner_id
  from public.connections
  where id = p_connection_id;

  if v_org_id is null and v_owner_id is null then
    raise exception 'connection % not found', p_connection_id;
  end if;

  insert into public.audit_log (org_id, owner_id, actor, action, detail)
  values (v_org_id, v_owner_id, v_actor, p_action, coalesce(p_detail, '{}'::jsonb));
end;
$$;

revoke execute on function public.log_connection_audit(uuid, text, jsonb, uuid) from public, anon;
grant execute on function public.log_connection_audit(uuid, text, jsonb, uuid) to authenticated, service_role;
