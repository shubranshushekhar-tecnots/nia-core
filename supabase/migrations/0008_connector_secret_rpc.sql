-- 0008_connector_secret_rpc.sql
-- Vault read-side for connector services: a single, tightly-scoped
-- SECURITY DEFINER RPC that resolves one vault_secret_ref to its
-- decrypted JSON blob (e.g. { "user": ..., "password": ... } for MySQL).
--
-- Why an RPC and not direct vault.decrypted_secrets access: the `vault`
-- schema is never exposed via PostgREST (only `public`/`graphql_public`
-- are, per config.toml) — Supabase's own guidance is to never expose
-- vault.decrypted_secrets to the Data API directly. This function lives
-- in `public` (required — `private` isn't PostgREST-exposed either, so
-- it can't be called via supabase.rpc()), but it takes exactly one
-- argument, returns exactly one secret, and EXECUTE is revoked from
-- anon/authenticated and granted only to service_role. Nobody can browse
-- vault.decrypted_secrets through this — they can only ask for the one
-- ref they already hold.
--
-- Caller: connector-mysql, via its own SUPABASE_SERVICE_ROLE_KEY client.
-- By the time connector-mysql is invoked, Express has already read the
-- connections row (RLS-scoped to the caller's own JWT) to get that ref —
-- this function doesn't re-check org/owner access, it trusts that the ref
-- it was handed was already authorized upstream, same as the rest of the
-- dispatch layer's config/credential plumbing.

create or replace function public.resolve_connector_secret(p_ref text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret text;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where id = p_ref::uuid;

  if v_secret is null then
    raise exception 'vault secret not found for ref %', p_ref;
  end if;

  return v_secret::jsonb;
end;
$$;

revoke execute on function public.resolve_connector_secret(text) from public, anon, authenticated;
grant execute on function public.resolve_connector_secret(text) to service_role;
