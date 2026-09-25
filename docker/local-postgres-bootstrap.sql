-- Bootstrap for the local `postgres` service in docker-compose.yml — makes
-- a fresh, plain Postgres image look like what supabase/migrations/*.sql
-- expect, replacing the pieces the Supabase CLI's own Postgres image used
-- to provide. Runs once, automatically, via
-- /docker-entrypoint-initdb.d/ on first container start (Postgres only
-- runs these scripts against an empty data directory).
--
-- Scope confirmed by hand against every migration file (docs/plans/
-- local-dev.md Step 1/Step 2): pgcrypto, the anon/authenticated/
-- service_role roles, a minimal auth.users table + auth.uid()/auth.role(),
-- and a `vault.secrets` stub (see below). Nothing here is a real Vault or
-- GoTrue reimplementation — only the narrow shape existing migrations
-- reference.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Data-API-style roles. Supabase's own image creates these; plain
-- Postgres has none of them. `service_role` gets BYPASSRLS (matches
-- Supabase's own grant) so withServiceRole's `SET LOCAL ROLE service_role`
-- bypasses RLS exactly like it does against hosted/CLI Supabase.
--
-- The connecting role from DATABASE_URL (`postgres`, POSTGRES_USER below)
-- needs `SET ROLE` membership in all three for packages/db's
-- withActingUser/withServiceRole (`SET LOCAL ROLE authenticated` /
-- `SET LOCAL ROLE service_role`) to work — hosted Supabase's `postgres`
-- role already has this implicitly; plain Postgres needs it granted.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

grant anon, authenticated, service_role to current_user;

-- ---------------------------------------------------------------------
-- auth.users + auth.uid()/auth.role() — migrations 0001-0034 hard-
-- reference auth.users (FKs, an `after insert on auth.users` trigger) and
-- auth.uid() throughout every RLS policy/SECURITY DEFINER function.
-- 0035_better_auth.sql repoints every FK to public.user and drops the
-- trigger, but auth.users itself must exist for 0001-0034 to apply at
-- all. auth.uid()/auth.role() resolve identity from the same
-- `request.jwt.claims` GUC packages/db's withActingUser sets via
-- set_config — this is the real, permanent mechanism (not a shim to be
-- replaced later), matching Supabase's own implementation.
-- ---------------------------------------------------------------------
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

create or replace function auth.uid()
returns uuid
language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;

create or replace function auth.role()
returns text
language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '')
$$;

-- User-created schemas grant no privileges to PUBLIC by default (unlike the
-- `public` schema) — without this, every RLS policy/SECURITY DEFINER
-- function that calls auth.uid()/auth.role() throws "permission denied for
-- schema auth" as soon as `authenticated`/`service_role` evaluate it,
-- instead of the policy actually running. Confirmed by hand this session:
-- Supabase's own auth schema grants exactly this.
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Standard schema-wide grants Supabase's platform bootstrap applies to
-- every fresh project (documented, not proprietary). BYPASSRLS on
-- service_role above only skips row-level security checks — it still
-- needs ordinary table/sequence/routine GRANTs to read or write anything,
-- which the app migrations never issue themselves because Supabase's
-- platform normally applies this once, outside the migrations folder.
-- ALTER DEFAULT PRIVILEGES makes tables created by every migration that
-- runs after this bootstrap (all of them) inherit it automatically.
-- Confirmed by hand this session: without this, service_role gets
-- "permission denied for table X" on every table despite BYPASSRLS.
-- ---------------------------------------------------------------------
grant usage on schema public to postgres, anon, authenticated, service_role;
grant all on all tables in schema public to postgres, service_role;
grant all on all sequences in schema public to postgres, service_role;
grant all on all routines in schema public to postgres, service_role;
alter default privileges in schema public grant all on tables to postgres, service_role;
alter default privileges in schema public grant all on sequences to postgres, service_role;
alter default privileges in schema public grant all on routines to postgres, service_role;

-- ---------------------------------------------------------------------
-- vault.secrets stub — ONE migration (0033_count_vault_secrets_rpc.sql)
-- creates a `language sql` function whose body is
-- `select count(*) from vault.secrets`. Postgres validates `language sql`
-- function bodies at CREATE FUNCTION time (unlike the plpgsql functions
-- in 0008/0009/0027/0032 that also mention `vault.*`, which stay
-- unvalidated until called and are never invoked against a fresh
-- database), so migration 0033 fails outright without this table.
--
-- `vault.secrets` is part of Supabase's supabase_vault/pgsodium
-- extension and cannot be installed on plain Postgres — confirmed by
-- hand this session (docs/plans/local-dev.md). This is an empty stub,
-- not a real vault: the function it satisfies is itself dropped three
-- migrations later (0036/0037) and is never called with real data in
-- any fresh-database flow (bootstrap -> migrate -> seed -> app start).
-- ---------------------------------------------------------------------
create schema if not exists vault;

create table if not exists vault.secrets (
  id uuid primary key default gen_random_uuid()
);
