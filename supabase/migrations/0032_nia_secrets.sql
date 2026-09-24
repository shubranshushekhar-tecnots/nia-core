-- 0032_nia_secrets.sql
-- Replaces Supabase Vault as the credential store (docs/plans/secret-storage.md).
-- Envelope encryption now happens in the services (apps/api, apps/worker,
-- services/connector-*), never in Postgres: NIA_SECRET_MASTER_KEY lives only
-- in each service's environment and is never sent to or stored by the
-- database. This table holds only ciphertext plus the metadata needed to
-- decrypt it (encrypted_data_key, iv, auth_tag, algorithm, key_version).
--
-- Dual-read migration (docs/plans/secret-storage.md Step 2C): existing
-- connections.vault_secret_ref / write_grants.write_credential_vault_ref
-- columns are reused as-is for the transition — both already hold opaque
-- text refs, and a nia_secrets row's id fits the same column without a
-- schema change on either table. SecretStore.get(ref) tries nia_secrets by
-- id first, falling back to the existing Vault RPCs when the ref predates
-- this migration. Vault rows are untouched here; removal is a separate,
-- later migration once production has run on this path (TODO.md).
--
-- RLS mirrors public.connections (0007_connectors.sql) exactly: org-visible
-- or personally-owned, xor. Same trust boundary as create_connector_secret's
-- comment (0009): a nia_secrets row is only useful via the ref stored on an
-- RLS-protected connections/write_grants row, but unlike the Vault RPCs this
-- table also needs its own RLS, since apps/api now reads/writes it directly
-- (no service_role key, no SECURITY DEFINER wrapper for ordinary CRUD) —
-- see connections.ts's updateConnection for the read/merge/write path this
-- unlocks.
--
-- No update policy: secrets are immutable, matching merge_connector_secret's
-- existing "merge produces a new ref" shape rather than mutating in place.

-- =========================================================================
-- 1. nia_secrets
-- =========================================================================

create table public.nia_secrets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations (id) on delete cascade,
  owner_id uuid references auth.users (id),
  ciphertext text not null,
  encrypted_data_key text not null,
  iv text not null,
  auth_tag text not null,
  algorithm text not null default 'aes-256-gcm',
  key_version integer not null default 1,
  created_at timestamptz not null default now(),
  constraint nia_secrets_org_xor_owner check (
    (org_id is not null and owner_id is null) or (org_id is null and owner_id is not null)
  )
);

comment on table public.nia_secrets is
  'Envelope-encrypted credential storage, replacing Supabase Vault. Ciphertext '
  'and the per-secret encrypted data key only; the master key that decrypts '
  'the data key lives in service environments (NIA_SECRET_MASTER_KEY), never '
  'in this database. See docs/plans/secret-storage.md and docs/decisions.md.';

comment on column public.nia_secrets.encrypted_data_key is
  'The random per-secret AES-256-GCM data key, itself encrypted with the '
  'service''s NIA_SECRET_MASTER_KEY (identified by key_version). Rotation '
  '(TODO.md) re-encrypts this column without touching ciphertext/iv/auth_tag.';

comment on column public.nia_secrets.key_version is
  'Which master key encrypted encrypted_data_key. Lets key rotation identify '
  'rows still under an old master key without decrypting anything.';

create index nia_secrets_org_id_idx on public.nia_secrets (org_id);
create index nia_secrets_owner_id_idx on public.nia_secrets (owner_id);

alter table public.nia_secrets enable row level security;

create policy "nia_secrets_select_members"
  on public.nia_secrets for select
  using (
    (org_id is not null and private.is_member(org_id))
    or (org_id is null and owner_id = auth.uid())
  );

create policy "nia_secrets_insert_members"
  on public.nia_secrets for insert
  with check (
    (org_id is not null and owner_id is null and private.is_member(org_id))
    or (org_id is null and owner_id = auth.uid())
  );

create policy "nia_secrets_delete_members"
  on public.nia_secrets for delete
  using (
    (org_id is not null and private.is_member(org_id))
    or (org_id is null and owner_id = auth.uid())
  );

grant select, insert, delete on public.nia_secrets to authenticated;

-- service_role (apps/worker, services/connector-*) reads directly for
-- dispatch/backfill/verify — same "service_role bypasses RLS" precedent as
-- every other table here (e.g. resolve_connector_secret's callers).
grant select on public.nia_secrets to service_role;

-- =========================================================================
-- 2. decrypt_connector_secret_for_edit — the one new RPC this migration
--    needs. apps/api holds no service_role key (0009's header comment) and
--    resolve_connector_secret (0008) is service_role-only, so apps/api
--    still cannot decrypt a Vault-only secret itself during an edit. This
--    mirrors merge_connector_secret's decrypt half only (0027) — no merge,
--    no re-encrypt, no write — so SecretStore can do the merge and the
--    re-encryption in TypeScript instead of inside Postgres, where the
--    master key can never reach. Becomes dead code once every Vault secret
--    has been backfilled and the fallback is removed (TODO.md).
--
-- Same trust boundary as merge_connector_secret: no org/owner check here
-- either, callable by any authenticated user, because a ref is only ever
-- useful if it is already referenced by an RLS-protected connections row
-- the caller can read/write (see 0027's header comment for the identical
-- reasoning on merge_connector_secret/delete_connector_secret).
-- =========================================================================

create or replace function public.decrypt_connector_secret_for_edit(p_ref uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing text;
begin
  select decrypted_secret into v_existing
  from vault.decrypted_secrets
  where id = p_ref;

  if v_existing is null then
    raise exception 'vault secret not found for ref %', p_ref;
  end if;

  return v_existing::jsonb;
end;
$$;

revoke execute on function public.decrypt_connector_secret_for_edit(uuid) from public, anon;
grant execute on function public.decrypt_connector_secret_for_edit(uuid) to authenticated;
