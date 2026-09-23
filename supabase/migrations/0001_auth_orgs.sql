-- 0001_auth_orgs.sql
-- Auth slice: profiles, organizations, membership/roles, RLS, audit log.
-- All access control is enforced in Postgres (RLS + SECURITY DEFINER RPCs),
-- never in application code alone.

create extension if not exists pgcrypto;

-- =========================================================================
-- 1. profiles (1:1 with auth.users)
-- =========================================================================

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own"
  on public.profiles for select
  using (id = auth.uid());

create policy "profiles_update_own"
  on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- No insert/delete policies: rows are created only by handle_new_user()
-- below and deleted only via the auth.users cascade.

grant select, update on public.profiles to authenticated;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke execute on function public.set_updated_at() from public, anon, authenticated;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row
  execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- =========================================================================
-- 2. organizations
-- =========================================================================

create type public.org_role as enum ('member', 'admin', 'super_admin');

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);

alter table public.organizations enable row level security;

-- =========================================================================
-- 3. organization_members
-- =========================================================================

create table public.organization_members (
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.org_role not null,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create index organization_members_user_id_idx
  on public.organization_members (user_id);

alter table public.organization_members enable row level security;

-- =========================================================================
-- 4. private schema — SECURITY DEFINER helpers (break RLS recursion)
-- =========================================================================

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create or replace function private.is_member(p_org uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_members
    where org_id = p_org and user_id = auth.uid()
  );
$$;

create or replace function private.org_role(p_org uuid)
returns public.org_role
language sql
security definer
stable
set search_path = ''
as $$
  select role from public.organization_members
  where org_id = p_org and user_id = auth.uid();
$$;

create or replace function private.is_admin(p_org uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_members
    where org_id = p_org
      and user_id = auth.uid()
      and role in ('admin', 'super_admin')
  );
$$;

revoke execute on function private.is_member(uuid) from public, anon, authenticated;
revoke execute on function private.org_role(uuid) from public, anon, authenticated;
revoke execute on function private.is_admin(uuid) from public, anon, authenticated;
grant execute on function private.is_member(uuid) to authenticated;
grant execute on function private.org_role(uuid) to authenticated;
grant execute on function private.is_admin(uuid) to authenticated;

-- =========================================================================
-- 5. organizations policies
-- =========================================================================

create policy "organizations_select_members"
  on public.organizations for select
  using (private.is_member(id));

create policy "organizations_update_admins"
  on public.organizations for update
  using (private.is_admin(id))
  with check (private.is_admin(id));

-- No insert/delete policies: creation only via create_organization() RPC.

grant select, update on public.organizations to authenticated;

-- =========================================================================
-- 6. organization_members policies
-- =========================================================================

create policy "members_select_members"
  on public.organization_members for select
  using (private.is_member(org_id));

create policy "members_insert_admins"
  on public.organization_members for insert
  with check (
    private.is_admin(org_id)
    and (role <> 'super_admin' or private.org_role(org_id) = 'super_admin')
  );

create policy "members_update_admins"
  on public.organization_members for update
  using (
    private.is_admin(org_id)
    and (role <> 'super_admin' or private.org_role(org_id) = 'super_admin')
  )
  with check (
    private.is_admin(org_id)
    and (role <> 'super_admin' or private.org_role(org_id) = 'super_admin')
  );

create policy "members_delete_admins_or_self"
  on public.organization_members for delete
  using (
    user_id = auth.uid()  -- leaving the org yourself is always allowed
    or (
      private.is_admin(org_id)
      and (role <> 'super_admin' or private.org_role(org_id) = 'super_admin')
    )
  );

grant select, insert, update, delete on public.organization_members to authenticated;

-- Protect the last super_admin of an org from demotion/removal.
create or replace function private.protect_last_super_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  remaining int;
  target_org uuid;
begin
  target_org := coalesce(old.org_id, new.org_id);

  if (tg_op = 'DELETE' and old.role = 'super_admin')
     or (tg_op = 'UPDATE' and old.role = 'super_admin' and new.role <> 'super_admin') then
    select count(*) into remaining
    from public.organization_members
    where org_id = target_org and role = 'super_admin' and user_id <> old.user_id;

    if remaining = 0 then
      raise exception 'Cannot remove or demote the last super_admin of an organization';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke execute on function private.protect_last_super_admin() from public, anon, authenticated;

create trigger organization_members_protect_last_super_admin
  before update or delete on public.organization_members
  for each row
  execute function private.protect_last_super_admin();

-- =========================================================================
-- 7. audit_log (append-only)
-- =========================================================================

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  actor uuid references auth.users (id),
  action text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);

create index audit_log_org_id_created_at_idx
  on public.audit_log (org_id, created_at desc);

alter table public.audit_log enable row level security;

create policy "audit_log_select_admins"
  on public.audit_log for select
  using (private.is_admin(org_id));

-- No client insert/update/delete policies: writes only via private.log_audit().

grant select on public.audit_log to authenticated;

create or replace function private.log_audit(
  p_org uuid,
  p_action text,
  p_detail jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_log (org_id, actor, action, detail)
  values (p_org, auth.uid(), p_action, p_detail);
end;
$$;

-- Deliberately not granted to authenticated/anon: only callable from other
-- SECURITY DEFINER functions (e.g. create_organization) owned by the same
-- definer, which run with the OWNER's privileges regardless of these
-- revokes. This prevents any client from injecting arbitrary audit rows.
revoke execute on function private.log_audit(uuid, text, jsonb) from public, anon, authenticated;

-- =========================================================================
-- 8. create_organization RPC — atomic org + membership + audit
-- =========================================================================

create or replace function public.create_organization(p_name text, p_slug text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_org_id uuid;
begin
  insert into public.organizations (name, slug, created_by)
  values (p_name, p_slug, auth.uid())
  returning id into new_org_id;

  insert into public.organization_members (org_id, user_id, role)
  values (new_org_id, auth.uid(), 'super_admin');

  perform private.log_audit(new_org_id, 'organization.created', jsonb_build_object('name', p_name, 'slug', p_slug));

  return new_org_id;
end;
$$;

revoke execute on function public.create_organization(text, text) from public, anon, authenticated;
grant execute on function public.create_organization(text, text) to authenticated;
