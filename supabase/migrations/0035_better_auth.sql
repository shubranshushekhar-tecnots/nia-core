-- Replace Supabase Auth (GoTrue/auth.users) with Better Auth (public.user).
--
-- This migration:
--   1. Creates Better Auth's own tables: public.user, public.session,
--      public.account, public.verification.
--   2. Backfills public.user from auth.users under the SAME ids (see
--      packages/auth/src/config.ts's `advanced.database.generateId:
--      "uuid"` — Better Auth's ids are plain uuids, the same type/shape
--      auth.users.id already is), so every existing FK column that
--      currently points at an auth.users row keeps pointing at a row
--      that exists once step 3 repoints it at public.user. This is a
--      backward-compatible, data-preserving cutover for every row that
--      was actually reachable from auth.users, per the same rule every
--      other migration in this directory follows (see docs/decisions.md).
--      NOT backfilled: passwords/credentials. GoTrue's encrypted_password
--      format isn't compatible with Better Auth's hasher, so no
--      public.account row is created here. Any existing user must reset
--      their password once, post-migration, via
--      `pnpm --filter @nia/api set-password <email> <newPassword>`
--      (apps/api/src/scripts/setUserPassword.ts).
--   2.5. Self-heals any row whose FK-target id has no corresponding
--      public.user row (seen in the wild: rows that got inserted past a
--      live, validated FK, root cause unconfirmed — this migration makes
--      no assumption the database is clean). Depending on the column,
--      this either deletes the row, nulls the column, or conditionally
--      relaxes a NOT NULL column to nullable and nulls it — see the
--      STEP 2.5 comment block below for the full per-column reasoning and
--      TODO.md for the follow-up note on the columns that can lose their
--      NOT NULL. A database with no orphans is untouched by this step and
--      keeps every constraint as-is.
--   3. Drops the 20 FK columns' constraints pointing at auth.users and
--      re-adds them pointing at public.user, preserving each column's
--      original ON DELETE behavior. Succeeds unconditionally now, since
--      step 2.5 already resolved every remaining orphan.
--   4. Drops the `on_auth_user_created` trigger + `handle_new_user()`
--      function (replaced by Better Auth's `user.create.after` database
--      hook in packages/auth).
--
-- Does NOT touch the `auth` schema itself (still Supabase-managed) or any
-- RLS policy / SECURITY DEFINER function — those all resolve identity via
-- the `request.jwt.claims` GUC, which is set the same way regardless of
-- which table issued the id.

-- ============================================================================
-- STEP 1: Better Auth core tables
-- ============================================================================

create table if not exists public."user" (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  "emailVerified" boolean not null default false,
  image text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create table if not exists public."session" (
  id uuid primary key default gen_random_uuid(),
  "expiresAt" timestamptz not null,
  token text not null unique,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "ipAddress" text,
  "userAgent" text,
  "userId" uuid not null references public."user"(id) on delete cascade
);

create table if not exists public."account" (
  id uuid primary key default gen_random_uuid(),
  "accountId" text not null,
  "providerId" text not null,
  "userId" uuid not null references public."user"(id) on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope text,
  password text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create table if not exists public."verification" (
  id uuid primary key default gen_random_uuid(),
  identifier text not null,
  value text not null,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz default now(),
  "updatedAt" timestamptz default now()
);

create index if not exists session_userId_idx on public."session"("userId");
create index if not exists account_userId_idx on public."account"("userId");

-- ============================================================================
-- STEP 2: Backfill public.user from auth.users, under the same ids
-- ============================================================================
-- name is NOT NULL on public.user but auth.users has no native name column;
-- fall back to public.profiles.full_name (already keyed 1:1 on the same
-- id), then to the email's local-part if that's also null/empty.
-- emailVerified comes from auth.users.email_confirmed_at being set.
-- on conflict (id) do nothing makes this safe to re-run and safe on a
-- database where public.user already has rows (e.g. a fresh signup that
-- landed after step 1 created the table but before this statement ran).

insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
select
  u.id,
  coalesce(nullif(p.full_name, ''), split_part(u.email, '@', 1)),
  u.email,
  u.email_confirmed_at is not null,
  u.created_at,
  u.updated_at
from auth.users u
left join public.profiles p on p.id = u.id
where u.email is not null
on conflict (id) do nothing;

-- ============================================================================
-- STEP 2.5: Self-heal orphaned FK targets before repointing
-- ============================================================================
-- STEP 3 below repoints 20 FK columns to public.user(id). Any row whose
-- current value has no corresponding public.user row (i.e. no corresponding
-- auth.users row either, since STEP 2 just backfilled 1:1 from auth.users)
-- would make that FK add fail. Rather than assume a clean database, every
-- one of the 20 columns is handled here first, so this migration succeeds
-- against any database state, not just one with no orphans. Three
-- strategies, chosen per-column based on the column's actual constraints
-- and RLS semantics (all read from this repo's own migrations, not assumed):
--
--  (A) DELETE the row — used for PK columns (profiles.id), columns bound by
--      an `_org_xor_owner` CHECK constraint (nulling would violate the
--      check since org_id is already null in the orphan scenario), NOT NULL
--      columns whose value IS read by an RLS policy on SELECT/UPDATE/DELETE
--      (conversations.created_by — also referenced by messages' read
--      policy), and disposable/regenerable rows (source_profiles is a
--      profiling cache).
--  (B) NULL the column only — used for audit_log.actor, the one column
--      that is nullable, not part of any xor constraint, and pure
--      attribution on an otherwise-valid, worth-keeping audit row.
--  (C) Conditionally relax NOT NULL, then NULL the column — used for the 6
--      remaining NOT NULL columns that are pure provenance (checked only on
--      INSERT by RLS, never on SELECT/UPDATE/DELETE — see e.g. 0007's
--      "owner_user_id is provenance, not an access gate"), where deleting
--      the row would destroy a still-live, still-usable shared resource
--      (a connection, connector install, org, project, workflow, or
--      grant). The ALTER only runs if that specific column actually has an
--      orphaned row on this database — a database with clean data comes out
--      of this migration with all 6 NOT NULL constraints intact. See
--      TODO.md for the corresponding "app must still always set these on
--      insert" note.
--
-- Every branch RAISE NOTICEs what it did and how many rows, so none of this
-- is silent in the migration's output.

-- --- audit_log -----------------------------------------------------------

-- (B) audit_log.actor — nullable, not xor-constrained, pure attribution.
do $$
declare
  v_count integer;
begin
  update public.audit_log
  set actor = null
  where actor is not null
    and not exists (select 1 from public."user" u where u.id = audit_log.actor);
  get diagnostics v_count = row_count;
  if v_count > 0 then
    raise notice '0035_better_auth: nulled actor on % row(s) in public.audit_log with no matching public.user', v_count;
  end if;
end $$;

-- (A) audit_log.owner_id — xor-constrained with org_id.
do $$
declare
  v_count integer;
begin
  delete from public.audit_log a
  where a.owner_id is not null
    and not exists (select 1 from public."user" u where u.id = a.owner_id);
  get diagnostics v_count = row_count;
  if v_count > 0 then
    raise notice '0035_better_auth: deleted % row(s) from public.audit_log with orphaned owner_id (no matching public.user)', v_count;
  end if;
end $$;

-- --- connections -----------------------------------------------------------

-- (A) connections.owner_id — xor-constrained with org_id.
do $$
declare
  v_count integer;
begin
  delete from public.connections c
  where c.owner_id is not null
    and not exists (select 1 from public."user" u where u.id = c.owner_id);
  get diagnostics v_count = row_count;
  if v_count > 0 then
    raise notice '0035_better_auth: deleted % row(s) from public.connections with orphaned owner_id (no matching public.user)', v_count;
  end if;
end $$;

-- (C) connections.owner_user_id — provenance-only, not an access gate.
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.connections c
  where c.owner_user_id is not null
    and not exists (select 1 from public."user" u where u.id = c.owner_user_id);
  if v_count > 0 then
    alter table public.connections alter column owner_user_id drop not null;
    update public.connections
    set owner_user_id = null
    where owner_user_id is not null
      and not exists (select 1 from public."user" u where u.id = owner_user_id);
    raise notice '0035_better_auth: relaxed connections.owner_user_id to nullable and nulled % row(s) with orphaned owner_user_id (no matching public.user) — app code must still always set this on insert', v_count;
  end if;
end $$;

-- --- connector_installs -----------------------------------------------------------

-- (C) connector_installs.installed_by_user_id — provenance-only.
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.connector_installs ci
  where ci.installed_by_user_id is not null
    and not exists (select 1 from public."user" u where u.id = ci.installed_by_user_id);
  if v_count > 0 then
    alter table public.connector_installs alter column installed_by_user_id drop not null;
    update public.connector_installs
    set installed_by_user_id = null
    where installed_by_user_id is not null
      and not exists (select 1 from public."user" u where u.id = installed_by_user_id);
    raise notice '0035_better_auth: relaxed connector_installs.installed_by_user_id to nullable and nulled % row(s) with orphaned installed_by_user_id (no matching public.user) — app code must still always set this on insert', v_count;
  end if;
end $$;

-- (A) connector_installs.owner_id — xor-constrained with org_id.
do $$
declare
  v_count integer;
begin
  delete from public.connector_installs ci
  where ci.owner_id is not null
    and not exists (select 1 from public."user" u where u.id = ci.owner_id);
  get diagnostics v_count = row_count;
  if v_count > 0 then
    raise notice '0035_better_auth: deleted % row(s) from public.connector_installs with orphaned owner_id (no matching public.user)', v_count;
  end if;
end $$;

-- --- conversations -----------------------------------------------------------

-- (A) conversations.created_by — NOT NULL and read by RLS (own UPDATE
-- policy, plus messages' read policy), unlike other created_by columns.
do $$
declare
  v_count integer;
begin
  delete from public.conversations c
  where not exists (select 1 from public."user" u where u.id = c.created_by);
  get diagnostics v_count = row_count;
  if v_count > 0 then
    raise notice '0035_better_auth: deleted % row(s) from public.conversations with orphaned created_by (no matching public.user)', v_count;
  end if;
end $$;

-- (A) conversations.owner_id — xor-constrained with org_id.
do $$
declare
  v_count integer;
begin
  delete from public.conversations c
  where c.owner_id is not null
    and not exists (select 1 from public."user" u where u.id = c.owner_id);
  get diagnostics v_count = row_count;
  if v_count > 0 then
    raise notice '0035_better_auth: deleted % row(s) from public.conversations with orphaned owner_id (no matching public.user)', v_count;
  end if;
end $$;

-- --- messages -----------------------------------------------------------

-- (A) messages.owner_id — xor-constrained with org_id.
do $$
declare
  v_count integer;
begin
  delete from public.messages m
  where m.owner_id is not null
    and not exists (select 1 from public."user" u where u.id = m.owner_id);
  get diagnostics v_count = row_count;
  if v_count > 0 then
    raise notice '0035_better_auth: deleted % row(s) from public.messages with orphaned owner_id (no matching public.user)', v_count;
  end if;
end $$;

-- --- nia_secrets -----------------------------------------------------------

-- (A) nia_secrets.owner_id — xor-constrained with org_id.
do $$
declare
  v_count integer;
begin
  delete from public.nia_secrets s
  where s.owner_id is not null
    and not exists (select 1 from public."user" u where u.id = s.owner_id);
  get diagnostics v_count = row_count;
  if v_count > 0 then
    raise notice '0035_better_auth: deleted % row(s) from public.nia_secrets with orphaned owner_id (no matching public.user)', v_count;
  end if;
end $$;

-- --- organization_members -----------------------------------------------------------

-- (A) organization_members.user_id — NOT NULL, part of the membership PK.
do $$
declare
  v_count integer;
begin
  delete from public.organization_members om
  where not exists (select 1 from public."user" u where u.id = om.user_id);
  get diagnostics v_count = row_count;
  if v_count > 0 then
    raise notice '0035_better_auth: deleted % row(s) from public.organization_members with orphaned user_id (no matching public.user)', v_count;
  end if;
end $$;

-- --- organizations -----------------------------------------------------------

-- (C) organizations.created_by — provenance-only, no RLS keys off it.
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.organizations o
  where o.created_by is not null
    and not exists (select 1 from public."user" u where u.id = o.created_by);
  if v_count > 0 then
    alter table public.organizations alter column created_by drop not null;
    update public.organizations
    set created_by = null
    where created_by is not null
      and not exists (select 1 from public."user" u where u.id = created_by);
    raise notice '0035_better_auth: relaxed organizations.created_by to nullable and nulled % row(s) with orphaned created_by (no matching public.user) — app code must still always set this on insert', v_count;
  end if;
end $$;

-- --- profiles -----------------------------------------------------------

-- (A) profiles.id — the row's own primary key.
do $$
declare
  v_count integer;
begin
  delete from public.profiles p
  where not exists (select 1 from public."user" u where u.id = p.id);
  get diagnostics v_count = row_count;
  if v_count > 0 then
    raise notice '0035_better_auth: deleted % row(s) from public.profiles with orphaned id (no matching public.user)', v_count;
  end if;
end $$;

-- --- projects -----------------------------------------------------------

-- (C) projects.created_by — provenance-only, checked only on INSERT.
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.projects pr
  where pr.created_by is not null
    and not exists (select 1 from public."user" u where u.id = pr.created_by);
  if v_count > 0 then
    alter table public.projects alter column created_by drop not null;
    update public.projects
    set created_by = null
    where created_by is not null
      and not exists (select 1 from public."user" u where u.id = created_by);
    raise notice '0035_better_auth: relaxed projects.created_by to nullable and nulled % row(s) with orphaned created_by (no matching public.user) — app code must still always set this on insert', v_count;
  end if;
end $$;

-- (A) projects.owner_id — xor-constrained with org_id.
do $$
declare
  v_count integer;
begin
  delete from public.projects pr
  where pr.owner_id is not null
    and not exists (select 1 from public."user" u where u.id = pr.owner_id);
  get diagnostics v_count = row_count;
  if v_count > 0 then
    raise notice '0035_better_auth: deleted % row(s) from public.projects with orphaned owner_id (no matching public.user)', v_count;
  end if;
end $$;

-- --- source_profiles -----------------------------------------------------------

-- (A) source_profiles.profiled_by_user_id — NOT NULL, but the row itself
-- is a disposable/regenerable profiling cache.
do $$
declare
  v_count integer;
begin
  delete from public.source_profiles sp
  where not exists (select 1 from public."user" u where u.id = sp.profiled_by_user_id);
  get diagnostics v_count = row_count;
  if v_count > 0 then
    raise notice '0035_better_auth: deleted % row(s) from public.source_profiles with orphaned profiled_by_user_id (no matching public.user)', v_count;
  end if;
end $$;

-- --- workflow_runs -----------------------------------------------------------

-- (A) workflow_runs.owner_id — xor-constrained with org_id.
do $$
declare
  v_count integer;
begin
  delete from public.workflow_runs wr
  where wr.owner_id is not null
    and not exists (select 1 from public."user" u where u.id = wr.owner_id);
  get diagnostics v_count = row_count;
  if v_count > 0 then
    raise notice '0035_better_auth: deleted % row(s) from public.workflow_runs with orphaned owner_id (no matching public.user)', v_count;
  end if;
end $$;

-- --- workflows -----------------------------------------------------------

-- (C) workflows.created_by — provenance-only, checked only on INSERT.
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.workflows w
  where w.created_by is not null
    and not exists (select 1 from public."user" u where u.id = w.created_by);
  if v_count > 0 then
    alter table public.workflows alter column created_by drop not null;
    update public.workflows
    set created_by = null
    where created_by is not null
      and not exists (select 1 from public."user" u where u.id = created_by);
    raise notice '0035_better_auth: relaxed workflows.created_by to nullable and nulled % row(s) with orphaned created_by (no matching public.user) — app code must still always set this on insert', v_count;
  end if;
end $$;

-- (A) workflows.owner_id — xor-constrained with org_id.
do $$
declare
  v_count integer;
begin
  delete from public.workflows w
  where w.owner_id is not null
    and not exists (select 1 from public."user" u where u.id = w.owner_id);
  get diagnostics v_count = row_count;
  if v_count > 0 then
    raise notice '0035_better_auth: deleted % row(s) from public.workflows with orphaned owner_id (no matching public.user)', v_count;
  end if;
end $$;

-- --- write_grants -----------------------------------------------------------

-- (C) write_grants.granted_by_user_id — provenance-only; access is
-- entirely derived from the parent connection's org_id/owner_id.
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.write_grants wg
  where wg.granted_by_user_id is not null
    and not exists (select 1 from public."user" u where u.id = wg.granted_by_user_id);
  if v_count > 0 then
    alter table public.write_grants alter column granted_by_user_id drop not null;
    update public.write_grants
    set granted_by_user_id = null
    where granted_by_user_id is not null
      and not exists (select 1 from public."user" u where u.id = granted_by_user_id);
    raise notice '0035_better_auth: relaxed write_grants.granted_by_user_id to nullable and nulled % row(s) with orphaned granted_by_user_id (no matching public.user) — app code must still always set this on insert', v_count;
  end if;
end $$;

-- ============================================================================
-- STEP 3: Repoint the 20 FK columns from auth.users to public.user
-- ============================================================================
-- Each constraint is dropped and re-added with the exact same column and
-- ON DELETE behavior it had before — only the referenced table changes.

alter table public.audit_log drop constraint audit_log_actor_fkey;
alter table public.audit_log add constraint audit_log_actor_fkey
  foreign key (actor) references public."user"(id) on delete no action;

alter table public.audit_log drop constraint audit_log_owner_id_fkey;
alter table public.audit_log add constraint audit_log_owner_id_fkey
  foreign key (owner_id) references public."user"(id) on delete no action;

alter table public.connections drop constraint connections_owner_id_fkey;
alter table public.connections add constraint connections_owner_id_fkey
  foreign key (owner_id) references public."user"(id) on delete no action;

alter table public.connections drop constraint connections_owner_user_id_fkey;
alter table public.connections add constraint connections_owner_user_id_fkey
  foreign key (owner_user_id) references public."user"(id) on delete no action;

alter table public.connector_installs drop constraint connector_installs_installed_by_user_id_fkey;
alter table public.connector_installs add constraint connector_installs_installed_by_user_id_fkey
  foreign key (installed_by_user_id) references public."user"(id) on delete no action;

alter table public.connector_installs drop constraint connector_installs_owner_id_fkey;
alter table public.connector_installs add constraint connector_installs_owner_id_fkey
  foreign key (owner_id) references public."user"(id) on delete no action;

alter table public.conversations drop constraint conversations_created_by_fkey;
alter table public.conversations add constraint conversations_created_by_fkey
  foreign key (created_by) references public."user"(id) on delete no action;

alter table public.conversations drop constraint conversations_owner_id_fkey;
alter table public.conversations add constraint conversations_owner_id_fkey
  foreign key (owner_id) references public."user"(id) on delete no action;

alter table public.messages drop constraint messages_owner_id_fkey;
alter table public.messages add constraint messages_owner_id_fkey
  foreign key (owner_id) references public."user"(id) on delete no action;

alter table public.nia_secrets drop constraint nia_secrets_owner_id_fkey;
alter table public.nia_secrets add constraint nia_secrets_owner_id_fkey
  foreign key (owner_id) references public."user"(id) on delete no action;

alter table public.organization_members drop constraint organization_members_user_id_fkey;
alter table public.organization_members add constraint organization_members_user_id_fkey
  foreign key (user_id) references public."user"(id) on delete cascade;

alter table public.organizations drop constraint organizations_created_by_fkey;
alter table public.organizations add constraint organizations_created_by_fkey
  foreign key (created_by) references public."user"(id) on delete no action;

alter table public.profiles drop constraint profiles_id_fkey;
alter table public.profiles add constraint profiles_id_fkey
  foreign key (id) references public."user"(id) on delete cascade;

alter table public.projects drop constraint projects_created_by_fkey;
alter table public.projects add constraint projects_created_by_fkey
  foreign key (created_by) references public."user"(id) on delete no action;

alter table public.projects drop constraint projects_owner_id_fkey;
alter table public.projects add constraint projects_owner_id_fkey
  foreign key (owner_id) references public."user"(id) on delete no action;

alter table public.source_profiles drop constraint source_profiles_profiled_by_user_id_fkey;
alter table public.source_profiles add constraint source_profiles_profiled_by_user_id_fkey
  foreign key (profiled_by_user_id) references public."user"(id) on delete no action;

alter table public.workflow_runs drop constraint workflow_runs_owner_id_fkey;
alter table public.workflow_runs add constraint workflow_runs_owner_id_fkey
  foreign key (owner_id) references public."user"(id) on delete no action;

alter table public.workflows drop constraint workflows_created_by_fkey;
alter table public.workflows add constraint workflows_created_by_fkey
  foreign key (created_by) references public."user"(id) on delete no action;

alter table public.workflows drop constraint workflows_owner_id_fkey;
alter table public.workflows add constraint workflows_owner_id_fkey
  foreign key (owner_id) references public."user"(id) on delete no action;

alter table public.write_grants drop constraint write_grants_granted_by_user_id_fkey;
alter table public.write_grants add constraint write_grants_granted_by_user_id_fkey
  foreign key (granted_by_user_id) references public."user"(id) on delete no action;

-- ============================================================================
-- STEP 4: Drop the GoTrue-era auto-profile trigger
-- ============================================================================
-- Replaced by the `user.create.after` databaseHook in packages/auth, which
-- runs the same insert against public.profiles on the same pool/role.

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();
