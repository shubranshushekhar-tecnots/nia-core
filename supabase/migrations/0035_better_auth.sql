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
--      that exists once step 3 repoints it at public.user. No table is
--      cleared and no data is deleted — this is a backward-compatible,
--      data-preserving cutover, per the same rule every other migration
--      in this directory follows (see docs/decisions.md).
--      NOT backfilled: passwords/credentials. GoTrue's encrypted_password
--      format isn't compatible with Better Auth's hasher, so no
--      public.account row is created here. Any existing user must reset
--      their password once, post-migration, via
--      `pnpm --filter @nia/api set-password <email> <newPassword>`
--      (apps/api/src/scripts/setUserPassword.ts).
--   3. Drops the 20 FK columns' constraints pointing at auth.users and
--      re-adds them pointing at public.user, preserving each column's
--      original ON DELETE behavior. Succeeds without deleting anything,
--      since step 2 already backfilled every id these FKs reference.
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
