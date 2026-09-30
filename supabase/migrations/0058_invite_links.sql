-- 0058_invite_links.sql
-- Subscription Phase 2, Slice 4 ("invite links + accept flow").
--
-- Org-only feature: invite_links.org_id is not null, no owner_id/personal-
-- workspace branch anywhere in this file. Personal workspaces have no
-- admin/owner distinction (single-user, owner_id = auth.uid() everywhere
-- else in this schema) so "invite someone into my personal workspace"
-- isn't a concept this migration needs to support.
--
-- Token handling: the raw 32-byte token is generated and SHA-256-hashed in
-- Node (apps/web/src/lib/invites/actions.ts), never in Postgres. Every RPC
-- below only ever sees/stores p_token_hash — the raw token exists only in
-- the one-time creation response and the accept-page URL, never at rest.
--
-- RPC-only writes, same "forgeable gate" reasoning as 0016_write_grants.sql
-- and 0014_workflow_check_runs.sql: direct client insert/update/delete is
-- revoked at both the RLS-policy and table-grant layers; create_invite/
-- revoke_invite/accept_invite (all SECURITY DEFINER) are the only path in.
--
-- created_by references public."user"(id), NOT auth.users(id) — per
-- 0035_better_auth.sql, public."user" is the live identity table post
-- Better-Auth-cutover; auth.users is a stub kept alive locally only so
-- migrations 0001-0034 still apply. Same reasoning applies to
-- accept_invite's email-domain check below: it reads public."user".email,
-- never auth.users.email (unpopulated for any user created after 0035).

-- =========================================================================
-- 1. Table
-- =========================================================================

create table public.invite_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  role public.org_role not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  max_uses integer check (max_uses is null or max_uses > 0),
  uses integer not null default 0 check (uses >= 0),
  email_domain text,
  revoked_at timestamptz,
  created_by uuid not null references public."user" (id),
  created_at timestamptz not null default now()
);

create index invite_links_org_id_idx on public.invite_links (org_id);

comment on column public.invite_links.token_hash is
  'SHA-256 hex digest of the raw invite token. The raw token is never '
  'stored — only Node (apps/web/src/lib/invites/actions.ts) ever sees it, '
  'in the one-time creation response.';

comment on column public.invite_links.max_uses is
  'Null = unlimited. uses is incremented atomically inside accept_invite '
  '(single UPDATE ... WHERE uses < max_uses, row-locked) so two concurrent '
  'accepts against a max_uses=1 link cannot both succeed.';

comment on column public.invite_links.email_domain is
  'Optional advisory lock: accept_invite compares this against the '
  'accepting user''s public."user".email domain. Advisory only — see '
  'packages/auth/src/config.ts:61-65 (emailAndPassword has no '
  'requireEmailVerification), so a self-reported email cannot be trusted '
  'as proof of domain ownership. UI must say so (apps/web invites page).';

alter table public.invite_links enable row level security;

create policy "invite_links_select_admin"
  on public.invite_links for select
  using (private.is_admin(org_id));

-- No insert/update/delete policies: RPC-only, enforced below.
revoke insert, update, delete on public.invite_links from authenticated;
grant select on public.invite_links to authenticated;

-- =========================================================================
-- 2. create_invite — admin/owner; only an owner may create an owner-role
--    invite.
-- =========================================================================

create or replace function public.create_invite(
  p_org_id uuid,
  p_role public.org_role,
  p_token_hash text,
  p_expires_at timestamptz,
  p_max_uses integer,
  p_email_domain text
)
returns public.invite_links
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_role public.org_role;
  v_row public.invite_links;
begin
  v_caller_role := private.org_role(p_org_id);

  if v_caller_role is null or v_caller_role not in ('admin', 'owner') then
    raise exception 'not authorized to create invites for org %', p_org_id;
  end if;

  if p_role = 'owner' and v_caller_role <> 'owner' then
    raise exception 'only an owner may create an owner-role invite';
  end if;

  insert into public.invite_links (org_id, role, token_hash, expires_at, max_uses, email_domain, created_by)
  values (p_org_id, p_role, p_token_hash, p_expires_at, p_max_uses, p_email_domain, auth.uid())
  returning * into v_row;

  perform private.log_audit(
    p_org_id,
    'invite.created',
    jsonb_build_object('inviteId', v_row.id, 'role', p_role, 'expiresAt', p_expires_at, 'maxUses', p_max_uses, 'emailDomain', p_email_domain)
  );

  return v_row;
end;
$$;

revoke execute on function public.create_invite(uuid, public.org_role, text, timestamptz, integer, text) from public, anon;
grant execute on function public.create_invite(uuid, public.org_role, text, timestamptz, integer, text) to authenticated;

-- =========================================================================
-- 3. revoke_invite — admin/owner of the invite's org; soft-delete only.
-- =========================================================================

create or replace function public.revoke_invite(p_invite_id uuid)
returns public.invite_links
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_row public.invite_links;
begin
  select org_id into v_org_id from public.invite_links where id = p_invite_id;
  if v_org_id is null then
    raise exception 'invite % not found', p_invite_id;
  end if;

  if not private.is_admin(v_org_id) then
    raise exception 'not authorized for invite %', p_invite_id;
  end if;

  update public.invite_links
    set revoked_at = now()
    where id = p_invite_id and revoked_at is null
    returning * into v_row;

  if v_row.id is null then
    raise exception 'invite % is already revoked', p_invite_id;
  end if;

  perform private.log_audit(v_org_id, 'invite.revoked', jsonb_build_object('inviteId', p_invite_id));

  return v_row;
end;
$$;

revoke execute on function public.revoke_invite(uuid) from public, anon;
grant execute on function public.revoke_invite(uuid) to authenticated;

-- =========================================================================
-- 4. accept_invite — requires sign-in (enforced by apps/web middleware
--    before this RPC is ever called, see middleware.ts's PUBLIC_PATHS).
--    Atomic uses-increment; already-a-member is a no-op (no role change,
--    no audit row) per spec.
-- =========================================================================

create or replace function public.accept_invite(p_token_hash text)
returns table (org_id uuid, org_name text, org_slug text, role public.org_role, already_member boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite public.invite_links;
  v_caller_email text;
  v_existing_role public.org_role;
begin
  select * into v_invite from public.invite_links where token_hash = p_token_hash;
  if v_invite.id is null then
    raise exception 'invite link is invalid';
  end if;

  if v_invite.revoked_at is not null then
    raise exception 'invite link has been revoked';
  end if;

  if v_invite.expires_at <= now() then
    raise exception 'invite link has expired';
  end if;

  if v_invite.max_uses is not null and v_invite.uses >= v_invite.max_uses then
    raise exception 'invite link has already been used';
  end if;

  select om.role into v_existing_role
  from public.organization_members om
  where om.org_id = v_invite.org_id and om.user_id = auth.uid();

  if v_existing_role is not null then
    -- Already a member: no role change, no uses increment, no audit row.
    return query
      select o.id, o.name, o.slug, v_existing_role, true
      from public.organizations o
      where o.id = v_invite.org_id;
    return;
  end if;

  if v_invite.email_domain is not null then
    select u.email into v_caller_email from public."user" u where u.id = auth.uid();
    if v_caller_email is null or lower(split_part(v_caller_email, '@', 2)) <> lower(v_invite.email_domain) then
      raise exception 'this invite is restricted to % email addresses', v_invite.email_domain;
    end if;
  end if;

  -- Atomic, race-safe: re-checks revoked/expiry/max_uses in the WHERE
  -- clause under the row lock UPDATE takes, so two concurrent acceptors
  -- of a max_uses=1 link cannot both pass — the second's UPDATE matches
  -- zero rows once the first commits its uses increment.
  update public.invite_links
    set uses = uses + 1
    where id = v_invite.id
      and revoked_at is null
      and expires_at > now()
      and (max_uses is null or uses < max_uses)
    returning * into v_invite;

  if v_invite.id is null then
    raise exception 'invite link has already been used';
  end if;

  insert into public.organization_members (org_id, user_id, role)
  values (v_invite.org_id, auth.uid(), v_invite.role);

  perform private.log_audit(v_invite.org_id, 'invite.accepted', jsonb_build_object('inviteId', v_invite.id, 'role', v_invite.role));

  return query
    select o.id, o.name, o.slug, v_invite.role, false
    from public.organizations o
    where o.id = v_invite.org_id;
end;
$$;

revoke execute on function public.accept_invite(text) from public, anon;
grant execute on function public.accept_invite(text) to authenticated;
