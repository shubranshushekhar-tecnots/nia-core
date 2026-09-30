-- 0060_org_member_profiles_rpc.sql
-- Subscription Phase 2, Slice 7 ("Members & roles page").
--
-- public.organization_members already lets any org member see every other
-- member's row (members_select_members policy, 0001_auth_orgs.sql) — but
-- display name/email live in public."user" (Better Auth's table,
-- 0035_better_auth.sql), which carries NO RLS policies and NO grant to
-- `authenticated` at all: confirmed it's read only by Better Auth's own
-- adapter (a separate pg.Pool) and by manageStaff.ts's service-role script
-- (0048_staff_2fa.sql's header comment). A plain withActingUser SELECT
-- against public."user" fails outright with "permission denied for table
-- user" (no grant, table-grant layer blocks before RLS is even relevant).
--
-- Rather than grant broad SELECT on public."user" to authenticated (which
-- would let ANY authenticated user read ANY other user's name/email
-- globally, not just their own org-mates), this adds one SECURITY DEFINER
-- RPC that checks the caller is a member of p_org_id, then joins
-- organization_members -> public."user" scoped to that one org — same
-- "needs to read across the RLS boundary, so it's an RPC, not a broadened
-- grant" precedent as create_invite/revoke_invite/accept_invite
-- (0058_invite_links.sql).

create or replace function public.list_org_member_profiles(p_org_id uuid)
returns table (user_id uuid, name text, email text, role public.org_role, joined_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_member(p_org_id) then
    raise exception 'not authorized for org %', p_org_id;
  end if;

  return query
    select om.user_id, u.name, u.email, om.role, om.created_at
    from public.organization_members om
    join public."user" u on u.id = om.user_id
    where om.org_id = p_org_id
    order by om.created_at asc;
end;
$$;

revoke execute on function public.list_org_member_profiles(uuid) from public, anon;
grant execute on function public.list_org_member_profiles(uuid) to authenticated;
