-- 0029_connection_name_unique.sql
-- Item 6.1 (fix-chain plan): connections had no uniqueness constraint on
-- display_name at all — only `handle` (0007_connectors.sql) is deduped, and
-- handle is minted from display_name + a collision suffix, so two
-- connections could quietly end up named e.g. both "Neon Postgres",
-- indistinguishable in the Connections Hub and any connection picker.
--
-- Expression index on (coalesce(org_id, owner_id), lower(display_name)) —
-- same org-vs-personal scoping shape as 0007's own `unique (org_id, handle)`
-- / `unique (owner_id, handle)` pairs, collapsed into a single expression
-- index (rather than two plain `unique` constraints) because org_id/owner_id
-- are XOR'd (0007's connections_org_xor_owner check) and NULLs are never
-- equal in Postgres — two personal (org_id null) connections' `unique
-- (owner_id, handle)` already relies on this same coalesce-free NULL
-- distinctness for handle, but a *display_name* uniqueness check needs the
-- coalesce so a personal connection and an org connection scoped to the
-- same coalesce()'d id are compared correctly; simpler to express as one
-- expression index than replicate 0007's two-constraint pattern here.
-- lower() makes it case-insensitive, matching how apps/api's createConnection/
-- updateConnection will report the conflict (Item 6.1's NAME_TAKEN check is
-- also case-insensitive).
--
-- Dedupe-first: this is a forward-only migration against a possibly
-- populated table (CONVENTIONS.md's "additive, forward-only" convention doesn't
-- mean data can't already violate a constraint being added), so any
-- pre-existing duplicate group must be resolved before the index can be
-- created, or `create unique index` itself fails outright. Renames every row
-- but the first (ordered by created_at, id, so the oldest/most-canonical
-- connection in a group keeps its original name) by appending a suffix
-- derived from the row's own id — guaranteed unique per row, so the rename
-- itself can never collide with another row (including another renamed row
-- in the same group).
do $$
begin
  update public.connections c
  set display_name = c.display_name || ' (' || substr(c.id::text, 1, 8) || ')'
  from (
    select id, row_number() over (
      partition by coalesce(org_id, owner_id), lower(display_name)
      order by created_at, id
    ) as rn
    from public.connections
  ) dup
  where dup.id = c.id and dup.rn > 1;
end $$;

create unique index connections_scope_display_name_unique_idx
  on public.connections (coalesce(org_id, owner_id), lower(display_name));
