-- 0020_source_profiles.sql
-- Phase 10 — source profiler cache. One row per (connection, entity):
-- upserted every time apps/worker's profile_run job computes a fresh
-- EntityProfile (packages/schemas/src/profile.ts). Reused when
-- schema_hash still matches the entity's current introspected schema and
-- profiled_at is under 24h old (apps/api/src/services/connections.ts);
-- otherwise apps/api re-profiles and upserts again. Manual refresh just
-- forces that same re-profile/upsert path, bypassing the freshness check.
--
-- Same "no own org_id/owner_id, scope derived via connection_id FK" shape
-- as write_grants (0007_connectors.sql) — a profile's access boundary is
-- entirely its parent connection's, so there's nothing to duplicate here.

create table public.source_profiles (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.connections (id) on delete cascade,
  entity_namespace text not null,
  entity_name text not null,
  -- Hash of the entity's IntrospectResponse fields (name+type) at profile
  -- time — the freshness check's cache key. Distinct from profile_hash
  -- (jsonb signature hash below): this one detects "the source schema
  -- changed", that one detects "the profiled DATA's shape changed".
  schema_hash text not null,
  sample_method text not null check (sample_method in ('keyset-head-tail', 'full-table', 'no-key-scan')),
  sample_size integer not null check (sample_size >= 0),
  -- ColumnStats[] (packages/schemas/src/profile.ts) — per-column counts,
  -- parse rates, min/max, failing examples (<=3, <=50 chars each).
  stats jsonb not null,
  -- ColumnSignature[] — coarse per-column shape, no exact counts.
  signature jsonb not null,
  profile_hash text not null,
  profiled_at timestamptz not null,
  profiled_by_user_id uuid not null references auth.users (id),
  constraint source_profiles_unique_entity unique (connection_id, entity_namespace, entity_name)
);

create index source_profiles_connection_id_idx on public.source_profiles (connection_id);

alter table public.source_profiles enable row level security;

create policy "source_profiles_select_members"
  on public.source_profiles for select
  using (
    exists (
      select 1 from public.connections c
      where c.id = connection_id
        and (
          (c.org_id is not null and private.is_member(c.org_id))
          or (c.org_id is null and c.owner_id = auth.uid())
        )
    )
  );

create policy "source_profiles_insert_members"
  on public.source_profiles for insert
  with check (
    profiled_by_user_id = auth.uid()
    and exists (
      select 1 from public.connections c
      where c.id = connection_id
        and (
          (c.org_id is not null and private.is_member(c.org_id))
          or (c.org_id is null and c.owner_id = auth.uid())
        )
    )
  );

-- Update is how a re-profile overwrites the cached row in place (upsert
-- on the unique constraint above) — same shape as write_grants' update
-- policy (revoke), not a general free-form edit.
create policy "source_profiles_update_members"
  on public.source_profiles for update
  using (
    exists (
      select 1 from public.connections c
      where c.id = connection_id
        and (
          (c.org_id is not null and private.is_member(c.org_id))
          or (c.org_id is null and c.owner_id = auth.uid())
        )
    )
  )
  with check (
    profiled_by_user_id = auth.uid()
    and exists (
      select 1 from public.connections c
      where c.id = connection_id
        and (
          (c.org_id is not null and private.is_member(c.org_id))
          or (c.org_id is null and c.owner_id = auth.uid())
        )
    )
  );

grant select, insert, update on public.source_profiles to authenticated;
