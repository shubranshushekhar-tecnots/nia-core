-- 0033_count_vault_secrets_rpc.sql
-- One narrow RPC to support the Vault -> nia_secrets backfill/verify tooling
-- (docs/plans/secret-storage.md Step 2C, apps/worker/scripts/secrets-*.ts):
-- a total count of vault.secrets rows, and nothing else. Same "counts only,
-- never values" boundary as Step 1's inventory ask, and the same pattern as
-- resolve_connector_secret (0008)/decrypt_connector_secret_for_edit (0032)
-- for exposing a narrow slice of the `vault` schema without ever exposing
-- vault.decrypted_secrets itself through PostgREST.
--
-- Used to report the orphan count: vault secrets that exist but are no
-- longer referenced by any connections.vault_secret_ref or
-- write_grants.write_credential_vault_ref (left behind by past credential
-- edits, since neither path has ever deleted the pre-edit Vault row -- see
-- TODO.md). orphanCount = count_vault_secrets() - (distinct live refs).

create or replace function public.count_vault_secrets()
returns integer
language sql
security definer
set search_path = ''
as $$
  select count(*)::integer from vault.secrets;
$$;

revoke execute on function public.count_vault_secrets() from public, anon, authenticated;
grant execute on function public.count_vault_secrets() to service_role;
