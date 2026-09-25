-- 0036_drop_dead_vault_secret_rpcs.sql
-- Drops merge_connector_secret and delete_connector_secret (0027) — dead
-- code left over from before the Vault-removal step (see docs/decisions.md's
-- "Replace Supabase Vault with application-level envelope encryption for
-- connector/write-grant secrets" entry). apps/api's connections.ts/grants.ts
-- no longer call either RPC (confirmed by grep — the envelope-encryption
-- secret store, packages/secrets/src/store.ts, replaced the merge/delete-by-
-- vault-ref flow entirely), and vault.delete_secret(uuid) — which
-- delete_connector_secret's body called — does not exist in this Postgres's
-- supabase_vault extension, so both were already silently unreachable code.
--
-- decrypt_connector_secret_for_edit (0032) is NOT touched here — apps/api's
-- lib/secretStore.ts still calls it for pre-envelope-encryption refs.

drop function if exists public.merge_connector_secret(uuid, jsonb);
drop function if exists public.delete_connector_secret(uuid);
