-- 0037_drop_vault_rpcs.sql
-- Drops the remaining Vault-era RPCs — the ones 0036 deliberately left in
-- place because live code (apps/worker's Vault->nia_secrets backfill/verify
-- tooling, apps/api's decrypt_connector_secret_for_edit legacy fallback)
-- still called them. That code has since been converted to nia_secrets/
-- SecretStore and removed/updated (see docs/decisions.md's Vault-removal
-- entry) — every ref that ever lived only in Vault was confirmed backfilled
-- into nia_secrets first, both locally and on the remote linked project,
-- before any of this ran.
--
-- resolve_connector_secret (0008) — service_role-only Vault read, replaced
-- by SecretStore/@nia/secrets's direct nia_secrets read (apps/api's
-- lib/secretStore.ts, apps/worker's lib/secretStore.ts, and the three
-- connector services' createEnvKeySecretStore, none of which have a Vault
-- fallback left).
--
-- create_connector_secret (0009) — authenticated-callable Vault write,
-- replaced by SecretStore.put() everywhere it was still called (apps/api's
-- connections.ts/grants.ts, apps/worker's lib/eval/sandbox.ts, and every
-- apps/worker/scripts/*-smoke.ts fixture).
--
-- decrypt_connector_secret_for_edit (0032) — authenticated-callable
-- equivalent of resolve_connector_secret, used only by apps/api's
-- secretStore.ts get() as a fallback for refs that predated nia_secrets.
-- That fallback has been removed; RLS Probe 50 (which only ever tested
-- this RPC) was removed with it.
--
-- count_vault_secrets (0033) — service_role-only orphan-count helper, used
-- only by the now-deleted apps/worker/scripts/secrets-backfill.ts/
-- secrets-verify.ts.
--
-- Once these are gone, no application code or RPC references the `vault`
-- schema at all — only pgcrypto, the three Postgres roles (anon,
-- authenticated, service_role), and auth.uid() remain as genuine platform
-- dependencies (see docs/plans/local-dev.md).

drop function if exists public.resolve_connector_secret(text);
drop function if exists public.create_connector_secret(jsonb);
drop function if exists public.decrypt_connector_secret_for_edit(uuid);
drop function if exists public.count_vault_secrets();
