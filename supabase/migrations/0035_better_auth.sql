-- Replace Supabase Auth (GoTrue/auth.users) with Better Auth (public.user).
--
-- This migration:
--   1. Creates Better Auth's own tables: public.user, public.session,
--      public.account, public.verification.
--   2. Clears every row that transitively hangs off auth.users, in strict
--      child-before-parent order (verified against the live FK graph via
--      pg_constraint, not hand-derived), because the app's fresh
--      public.user table starts empty and any pre-existing row would
--      violate the new foreign keys added in step 3. This is written to
--      run safely whether the database is already empty (local, after an
--      earlier manual wipe) or still holds old rows (remote, at deploy
--      time) — every DELETE is unconditional and idempotent.
--   3. Drops the 20 FK columns' constraints pointing at auth.users and
--      re-adds them pointing at public.user, preserving each column's
--      original ON DELETE behavior.
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
-- STEP 2: Clear every row that transitively depends on auth.users
-- ============================================================================
--
-- Order (children before parents), verified by topologically sorting the
-- live FK graph rooted at these tables (see docs/plans/auth.md for the
-- pg_constraint query used to derive it):
--
--    1.  staging_objects            (child of connections, workflow_runs)
--    2.  clean_plans                (child of copilot_applied_plans, workflows)
--    3.  workflow_check_runs        (child of workflows)
--    4.  copilot_pending_actions    (child of workflows)
--    5.  workflow_graphs            (child of workflows)
--    6.  copilot_applied_plans      (child of workflows; self-referencing)
--    7.  workflow_runs              (child of workflows, organizations)
--    8.  workflows                  (child of projects, organizations)
--    9.  messages                   (child of conversations, organizations)
--    10. conversations              (child of organizations)
--    11. source_profiles            (child of connections)
--    12. write_grants               (child of connections)
--    13. connections                (child of organizations)
--    14. connector_installs         (child of organizations)
--    15. nia_secrets                (child of organizations)
--    16. organization_members       (child of organizations)
--    17. audit_log                  (child of organizations)
--    18. projects                   (child of organizations)
--    19. organizations              (root of the tree above)
--    20. profiles                   (independent — keyed 1:1 on auth.users.id)
--
-- (conversations.workflow_id -> workflows is ON DELETE SET NULL, so it does
-- not force conversations before workflows for safety — included here only
-- for readability of the dependency story.)
do $$
begin
  raise notice 'better-auth migration: clearing 20 tables in FK-safe order: staging_objects, clean_plans, workflow_check_runs, copilot_pending_actions, workflow_graphs, copilot_applied_plans, workflow_runs, workflows, messages, conversations, source_profiles, write_grants, connections, connector_installs, nia_secrets, organization_members, audit_log, projects, organizations, profiles';
end $$;

delete from public.staging_objects;
delete from public.clean_plans;
delete from public.workflow_check_runs;
delete from public.copilot_pending_actions;
delete from public.workflow_graphs;
delete from public.copilot_applied_plans;
delete from public.workflow_runs;
delete from public.workflows;
delete from public.messages;
delete from public.conversations;
delete from public.source_profiles;
delete from public.write_grants;
delete from public.connections;
delete from public.connector_installs;
delete from public.nia_secrets;

-- organization_members_protect_last_super_admin exists to stop normal app
-- usage from leaving an org ownerless one row at a time; it isn't meant to
-- block a deliberate full wipe, so it's suspended for this one statement
-- and immediately restored.
alter table public.organization_members disable trigger organization_members_protect_last_super_admin;
delete from public.organization_members;
alter table public.organization_members enable trigger organization_members_protect_last_super_admin;

delete from public.audit_log;
delete from public.projects;
delete from public.organizations;
delete from public.profiles;

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
