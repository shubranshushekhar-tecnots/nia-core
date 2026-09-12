-- 0007_connectors.sql
-- Connector system: installs, connections, write grants. Manifests
-- themselves are files (packages/schemas/src/connectors/*.ts), never rows —
-- connector_id here is a free-text slug matching a manifest's `id`, not a
-- foreign key, so a manifest can be added/removed without a migration.
--
-- Same org_id/owner_id xor shape as 0005_individual_workspace.sql: every
-- row is either org-scoped (install/connect is org-wide, visible to every
-- member) or personally-owned (an individual/org-less user's own
-- workspace). No table here special-cases "individual" — it's just the
-- owner_id branch, exactly like projects/workflows.
--
-- Also extends audit_log (0001_auth_orgs.sql) with the same xor shape:
-- connector installs/connects/tests/grants/revokes must be auditable for
-- individual users too, and the table was org-only until now. Additive:
-- org_id becomes nullable, owner_id is new, the existing 3-arg
-- private.log_audit() is untouched (still org-only, still used by
-- create_organization), and a new private.log_audit_personal() covers the
-- owner_id branch — a distinct function name rather than an overload, to
-- avoid any ambiguity in Postgres's default-argument overload resolution.

-- =========================================================================
-- 1. connector_installs — org-level (or personal-workspace) install
-- =========================================================================

create table public.connector_installs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations (id) on delete cascade,
  owner_id uuid references auth.users (id),
  -- Matches a packages/schemas connector manifest's `id` (e.g. "mysql").
  -- Not a foreign key: manifests are files, not rows.
  connector_id text not null check (connector_id ~ '^[a-z0-9-]+$'),
  installed_by_user_id uuid not null references auth.users (id),
  installed_at timestamptz not null default now(),
  constraint connector_installs_org_xor_owner check (
    (org_id is not null and owner_id is null) or (org_id is null and owner_id is not null)
  ),
  -- Each unique constraint is only ever load-bearing for its own branch:
  -- NULLs are never equal in Postgres, so two personal (org_id null) rows
  -- never collide on the org constraint, and vice versa.
  unique (org_id, connector_id),
  unique (owner_id, connector_id)
);

create index connector_installs_org_id_idx on public.connector_installs (org_id);
create index connector_installs_owner_id_idx on public.connector_installs (owner_id);

alter table public.connector_installs enable row level security;

create policy "connector_installs_select_members"
  on public.connector_installs for select
  using (
    (org_id is not null and private.is_member(org_id))
    or (org_id is null and owner_id = auth.uid())
  );

-- Install is org-level but ungated by role — every role can attempt it
-- (packages/schemas/src/can.ts's connectors.install is individual/member/
-- admin/owner). RLS mirrors that: any member, not just admin/owner.
create policy "connector_installs_insert_members"
  on public.connector_installs for insert
  with check (
    installed_by_user_id = auth.uid()
    and (
      (org_id is not null and owner_id is null and private.is_member(org_id))
      or (org_id is null and owner_id = auth.uid())
    )
  );

-- Uninstall (delete) is likewise any member, not just the installer —
-- same "work actions aren't role-gated" model as projects/workflows.
-- Route-level (not RLS) refuses uninstall while connections still
-- reference the connector; RLS only decides *who*, not *when*.
create policy "connector_installs_delete_members"
  on public.connector_installs for delete
  using (
    (org_id is not null and private.is_member(org_id))
    or (org_id is null and owner_id = auth.uid())
  );

grant select, insert, delete on public.connector_installs to authenticated;

-- =========================================================================
-- 2. connections — org-visible, user-owned
-- =========================================================================

create type public.connection_test_status as enum ('ok', 'error');

create table public.connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations (id) on delete cascade,
  owner_id uuid references auth.users (id),
  connector_id text not null check (connector_id ~ '^[a-z0-9-]+$'),
  -- "@mysql-sales" — immutable after creation (workflows/citations reference
  -- it), unique per workspace, minted by the app (collision-suffixed) from
  -- connector_id + display_name.
  handle text not null check (handle ~ '^@[a-z0-9][a-z0-9-]*$'),
  display_name text not null,
  -- Provenance/display only — "whose credential this is" for the UI and for
  -- audit's actor-vs-credential-owner distinction. NOT an access-control
  -- column: any org member can read/use/update/delete any connection in
  -- their org, same as projects/workflows.
  owner_user_id uuid not null references auth.users (id),
  -- Non-secret manifest config fields (host/port/database for MySQL) —
  -- deliberately in Postgres, not Vault: SSRF validation at save/connect
  -- time needs to see the host, and the connection pill shouldn't cost a
  -- Vault fetch to render.
  config jsonb not null default '{}'::jsonb,
  -- The secret manifest fields (user/password for MySQL) as one Vault
  -- reference — never resolved by Express, only passed through.
  vault_secret_ref text not null,
  cred_version integer not null default 1,
  last_test_status public.connection_test_status,
  last_test_latency_ms integer,
  last_test_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint connections_org_xor_owner check (
    (org_id is not null and owner_id is null) or (org_id is null and owner_id is not null)
  ),
  unique (org_id, handle),
  unique (owner_id, handle)
);

create index connections_org_id_idx on public.connections (org_id);
create index connections_owner_id_idx on public.connections (owner_id);

alter table public.connections enable row level security;

create trigger connections_set_updated_at
  before update on public.connections
  for each row
  execute function public.set_updated_at();

create policy "connections_select_members"
  on public.connections for select
  using (
    (org_id is not null and private.is_member(org_id))
    or (org_id is null and owner_id = auth.uid())
  );

create policy "connections_insert_members"
  on public.connections for insert
  with check (
    owner_user_id = auth.uid()
    and (
      (org_id is not null and owner_id is null and private.is_member(org_id))
      or (org_id is null and owner_id = auth.uid())
    )
  );

-- Any member can update (rename, rotate credential, re-test) any connection
-- in their org — owner_user_id is provenance, not an access gate.
create policy "connections_update_members"
  on public.connections for update
  using (
    (org_id is not null and private.is_member(org_id))
    or (org_id is null and owner_id = auth.uid())
  )
  with check (
    (org_id is not null and private.is_member(org_id))
    or (org_id is null and owner_id = auth.uid())
  );

create policy "connections_delete_members"
  on public.connections for delete
  using (
    (org_id is not null and private.is_member(org_id))
    or (org_id is null and owner_id = auth.uid())
  );

comment on column public.connections.cred_version is
  'Bumped ONLY when the Vault secret (user/password) is rotated — this is the '
  'second half of the connector-mysql pool cache key (connectionId:credVersion), '
  'and bumping it evicts/ages out warm pools holding the old credential. Editing '
  'config (host/port/database/display_name) must NOT bump this — those changes '
  'don''t invalidate an already-open, already-authenticated pool connection.';

grant select, insert, update, delete on public.connections to authenticated;

-- =========================================================================
-- 3. write_grants — belongs to the connection, not the person
-- =========================================================================
--
-- Unexercised in this pass (MySQL ships read-only), but shipped now so
-- PowerBI's push_dataset and friends don't need a second migration that
-- touches RLS and audit for something already known to be coming. No
-- org_id/owner_id of its own — scope comes entirely from the parent
-- connection via connection_id, matching "write grants belong to the
-- connection". Revocation is a soft-delete (revoked_at set), not a row
-- delete, so the grant history stays in the audit trail — hence no delete
-- policy/grant below, only select/insert/update.

create table public.write_grants (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.connections (id) on delete cascade,
  granted_by_user_id uuid not null references auth.users (id),
  -- Named schemas/tables this grant covers, e.g. {"schemas": ["sales"]}.
  scope jsonb not null default '{}'::jsonb,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index write_grants_connection_id_idx on public.write_grants (connection_id);

alter table public.write_grants enable row level security;

-- Scope is derived from the parent connection's org/owner, same pattern
-- private.is_member() itself uses (SECURITY DEFINER select, no recursion
-- risk since connections' own RLS isn't consulted — this is a plain
-- unrestricted subquery against the base table via the policy evaluator).
create policy "write_grants_select_members"
  on public.write_grants for select
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

create policy "write_grants_insert_members"
  on public.write_grants for insert
  with check (
    granted_by_user_id = auth.uid()
    and exists (
      select 1 from public.connections c
      where c.id = connection_id
        and (
          (c.org_id is not null and private.is_member(c.org_id))
          or (c.org_id is null and c.owner_id = auth.uid())
        )
    )
  );

-- Update is how a grant is "revoked" (revoked_at set) — see comment above.
create policy "write_grants_update_members"
  on public.write_grants for update
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
    exists (
      select 1 from public.connections c
      where c.id = connection_id
        and (
          (c.org_id is not null and private.is_member(c.org_id))
          or (c.org_id is null and c.owner_id = auth.uid())
        )
    )
  );

grant select, insert, update on public.write_grants to authenticated;

-- =========================================================================
-- 4. audit_log — extend to cover personal (org-less) workspaces
-- =========================================================================
-- Install/connect/test/grant/revoke/execute must all be auditable
-- regardless of whether the actor has an org — audit_log was org-only
-- until now. Additive: org_id becomes nullable, owner_id is new, the
-- existing 3-arg private.log_audit() (org-only) is untouched — a distinct
-- private.log_audit_personal() is added for the owner_id branch rather
-- than overloading, to keep call-site resolution unambiguous.

alter table public.audit_log alter column org_id drop not null;
alter table public.audit_log add column owner_id uuid references auth.users (id);

alter table public.audit_log add constraint audit_log_org_xor_owner check (
  (org_id is not null and owner_id is null) or (org_id is null and owner_id is not null)
);

create index audit_log_owner_id_created_at_idx on public.audit_log (owner_id, created_at desc);

drop policy "audit_log_select_admins" on public.audit_log;
create policy "audit_log_select_admins_or_self"
  on public.audit_log for select
  using (
    (org_id is not null and private.is_admin(org_id))
    or (org_id is null and owner_id = auth.uid())
  );

-- No client insert/update/delete policies — writes only via
-- private.log_audit() / private.log_audit_personal() (both SECURITY
-- DEFINER, neither granted to authenticated/anon).

create or replace function private.log_audit_personal(
  p_owner uuid,
  p_action text,
  p_detail jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_log (owner_id, actor, action, detail)
  values (p_owner, auth.uid(), p_action, p_detail);
end;
$$;

revoke execute on function private.log_audit_personal(uuid, text, jsonb) from public, anon, authenticated;
