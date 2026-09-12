-- 0009_connector_write_paths.sql
-- Two tightly-scoped SECURITY DEFINER RPCs, same shape/reasoning as
-- 0008_connector_secret_rpc.sql: `vault` and `private` are never
-- PostgREST-exposed (see 0008's header comment), so any write Express needs
-- to make against either has to go through a `public`-schema function.
--
-- Express deliberately holds no service_role key (apps/api/src/env.ts) — so
-- both functions here run as the caller's own `authenticated` role/JWT,
-- never as a shared elevated credential. The worker DOES get service_role
-- (following the workflow_runs precedent — see apps/worker/src/index.ts),
-- so log_execution_audit additionally accepts service_role callers with an
-- explicit actor, for when the worker gets a real dispatch call site.

-- =========================================================================
-- 1. create_connector_secret — Vault write side for connections.create
-- =========================================================================
-- Takes the connector's secret fields (e.g. { user, password } for MySQL)
-- and returns the new vault_secret_ref to store on the connections row. No
-- table access at all — purely a Vault write — so there is nothing here for
-- RLS to gate; any authenticated user may create a secret, but it is inert
-- until a connections row (RLS-protected) references it.

create or replace function public.create_connector_secret(p_secret jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  v_id := vault.create_secret(p_secret::text);
  return v_id::text;
end;
$$;

revoke execute on function public.create_connector_secret(jsonb) from public, anon;
grant execute on function public.create_connector_secret(jsonb) to authenticated;

-- =========================================================================
-- 2. log_execution_audit — the execution-audit chokepoint's insert path
-- =========================================================================
-- private.log_audit()/log_audit_personal() (0001/0007) are not usable here:
-- they live in `private` (not RPC-callable), aren't granted to
-- authenticated/service_role, and hard-code auth.uid() as the actor, which
-- is null for service_role callers. This function is the one and only
-- insert path @nia/schemas' ExecutionAuditInput contract (audit.ts) is
-- allowed to reach.
--
-- Actor handling is deliberately asymmetric:
--   - `authenticated` callers (Express, real JWT): actor is auth.uid(),
--     always — p_actor_user_id is ignored for this role, so no authenticated
--     caller can ever attribute an execution to someone other than
--     themselves.
--   - `service_role` callers (the worker, no live JWT): p_actor_user_id is
--     required and trusted, exactly as workflow_runs already trusts the
--     worker's service_role writes.
-- org_id/owner_id are looked up from the connection row itself (not taken
-- as a param) so a caller can't misreport which workspace's audit log an
-- execution lands in.

create or replace function public.log_execution_audit(
  p_connection_id uuid,
  p_connection_owner_user_id uuid,
  p_connector_id text,
  p_handle text,
  p_operation text,
  p_query text,
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
  values (
    v_org_id,
    v_owner_id,
    v_actor,
    'connection.execute',
    jsonb_build_object(
      'connectionId', p_connection_id,
      'connectionOwnerUserId', p_connection_owner_user_id,
      'connectorId', p_connector_id,
      'handle', p_handle,
      'operation', p_operation,
      'query', p_query
    )
  );
end;
$$;

revoke execute on function public.log_execution_audit(uuid, uuid, text, text, text, text, uuid) from public, anon;
grant execute on function public.log_execution_audit(uuid, uuid, text, text, text, text, uuid) to authenticated, service_role;
