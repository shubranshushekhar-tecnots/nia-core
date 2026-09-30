-- 0054_project_members.sql
-- Subscription Phase 2, Slice 2 (docs/plans/subscription-model.md, build
-- order step 2, "project membership"; resolves Open decision #3 —
-- "Members see all projects, or only ones they're added to?" — decided as:
-- members see only projects they're added to; admins/owners see all, per
-- the plan doc's own "(proposed)" wording under Roles.
--
-- Scope: `public.projects` only, NOT `public.workflows`/`workflow_runs`.
-- 0002_projects_workflows.sql's own header comment on the projects
-- policies ("Membership is the only gate for now — project-level roles
-- arrive later") anchors this to projects; extending the same
-- membership-gated visibility down to workflows/workflow_runs is a
-- separate decision (inherit the parent project's membership? a distinct
-- workflow_members table? does workflow_runs cascade too?) not asked for
-- by this slice's own scope ("project_members ... RLS rewrite" — project,
-- not workflow) and is left for a future slice.
--
-- Four pieces:
--   1. public.project_members — pure membership (no per-project role: the
--      product's Roles section, subscription-model.md, is entirely
--      org-level; project access is a plain in/out membership check).
--   2. private.is_project_member(p_project) — mirrors private.is_member's
--      exact shape (0001_auth_orgs.sql:115-126) — plus
--      private.can_manage_project(p_project), used only by project_members'
--      own policies below (see its own header comment for why it exists).
--   3. projects_select_members/_update_members/_delete_members — tighten
--      the org-scoped branch so a plain member additionally needs
--      private.is_admin(org_id) OR private.is_project_member(id); admins/
--      owners are unaffected (still see/edit every project in their org).
--      projects_insert_members is untouched: creation only ever required
--      org membership, and the project doesn't exist yet at insert time
--      for a project_members row to reference.
--   4. private.add_creator_as_project_member() — an AFTER INSERT trigger
--      on public.projects so every new project's creator is automatically
--      a project_member, org-scoped or personal alike (uniform for both
--      branches, which also keeps a future "move a personal project into
--      an org" migration simpler, since every project already has a
--      canonical creator-membership row regardless of org/personal status).
--
-- Grandfathering backfill (the most important part of this migration):
-- shipping the tightened RLS above with an EMPTY project_members table
-- would silently and immediately revoke every current non-creator org
-- member's visibility into every project they can see today — a severe
-- regression, not a grandfather of existing access (see
-- subscription-model.md's own use of "grandfathered": existing users
-- keep what they already have; only new behavior is opt-in-by-default
-- going forward). So every existing org-scoped project is backfilled
-- with a project_members row for EVERY current member of that project's
-- org (a full org-members x that-org's-projects cross join), not just
-- each project's own creator — preserving today's "any org member sees
-- every project" reality for everything that exists right now. Only
-- projects created after this migration ships get the tighter,
-- creator-only-by-default visibility (admins/owners can add others via
-- the insert policy below). Personal (owner_id) projects are backfilled
-- with just their own owner, for the same forward-uniformity reasoning
-- as the trigger.

-- =========================================================================
-- 1. public.project_members
-- =========================================================================

create table public.project_members (
  project_id uuid not null references public.projects (id) on delete cascade,
  -- References public.user, not auth.users — every FK added after
  -- 0035_better_auth.sql points at Better Auth's own user table (see that
  -- migration's STEP 3 for the other 20 columns repointed the same way).
  user_id uuid not null references public."user" (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create index project_members_user_id_idx
  on public.project_members (user_id);

alter table public.project_members enable row level security;

-- =========================================================================
-- 2. private.is_project_member(p_project) — mirrors private.is_member's
--    exact shape (0001_auth_orgs.sql:115-126).
-- =========================================================================

create or replace function private.is_project_member(p_project uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.project_members
    where project_id = p_project and user_id = auth.uid()
  );
$$;

revoke execute on function private.is_project_member(uuid) from public, anon, authenticated;
grant execute on function private.is_project_member(uuid) to authenticated;

-- private.can_manage_project(p_project) — "would this caller be allowed to
-- manage membership on this project": admin/owner of the parent org
-- (org-scoped) or the personal owner (individual). SECURITY DEFINER so the
-- query against public.projects inside it runs as the function owner,
-- bypassing that table's own RLS — same "break RLS recursion" reason
-- private.is_member/is_admin exist (0001_auth_orgs.sql:107-109). Without
-- this, referencing public.projects directly inside a project_members
-- policy expression would be evaluated under the querying role's own RLS
-- on projects, which is circular in spirit even though it happens to
-- still resolve correctly here — this sidesteps that entirely, matching
-- how every other cross-table policy check in this codebase is written.
create or replace function private.can_manage_project(p_project uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.projects p
    where p.id = p_project
      and (
        (p.org_id is not null and private.is_admin(p.org_id))
        or (p.org_id is null and p.owner_id = auth.uid())
      )
  );
$$;

revoke execute on function private.can_manage_project(uuid) from public, anon, authenticated;
grant execute on function private.can_manage_project(uuid) to authenticated;

-- =========================================================================
-- 3. project_members policies
-- =========================================================================

-- Visible to: the project's own members, any admin/owner of the parent
-- org (org-scoped projects), or the personal owner (individual projects).
-- A plain org member who ISN'T a project_member cannot even see who else
-- is a member of a project they themselves can't access — consistent
-- with projects_select_members below denying them the project row itself.
create policy "project_members_select_members_or_admins"
  on public.project_members for select
  using (
    user_id = auth.uid()
    or private.can_manage_project(project_id)
  );

-- Managing membership (adding someone) is admin/owner-of-org or the
-- personal owner only — mirrors organization_members' own admin-gated
-- insert policy (0001_auth_orgs.sql:186-191), just scoped to a project's
-- parent org/owner instead of the org directly.
create policy "project_members_insert_admins_or_owner"
  on public.project_members for insert
  with check (private.can_manage_project(project_id));

-- Removing membership: admin/owner-of-org or personal owner, PLUS a
-- self-service "leave a project yourself" branch — mirrors
-- members_delete_admins_or_self exactly (0001_auth_orgs.sql:204-212).
create policy "project_members_delete_admins_or_self"
  on public.project_members for delete
  using (
    user_id = auth.uid()
    or private.can_manage_project(project_id)
  );

-- No update policy: membership is pure add/remove, no mutable role
-- column to update.

grant select, insert, delete on public.project_members to authenticated;

-- =========================================================================
-- 4. projects — tighten select/update/delete for the org-scoped branch
--    only (insert is untouched; see header comment). Every recreated
--    policy is shown immediately after its current (0046_org_suspension.sql)
--    text for an easy side-by-side diff.
-- =========================================================================

-- --- projects_select_members ----------------------------------------------
-- Before (0005_individual_workspace.sql:34-40 — untouched by 0046, which
-- only amended insert/update/delete since suspension blocks writes, not
-- visibility):
--   using (
--     (org_id is not null and private.is_member(org_id))
--     or (org_id is null and owner_id = auth.uid())
--   );
drop policy "projects_select_members" on public.projects;
create policy "projects_select_members"
  on public.projects for select
  using (
    (org_id is not null and private.is_member(org_id) and (private.is_admin(org_id) or private.is_project_member(id)))
    or (org_id is null and owner_id = auth.uid())
  );

-- --- projects_update_members -----------------------------------------------
-- Before (0046_org_suspension.sql:108-118):
--   using (
--     (org_id is not null and private.is_member(org_id) and not private.is_org_suspended(org_id))
--     or (org_id is null and owner_id = auth.uid())
--   )
--   with check (
--     (org_id is not null and private.is_member(org_id) and not private.is_org_suspended(org_id))
--     or (org_id is null and owner_id = auth.uid())
--   );
drop policy "projects_update_members" on public.projects;
create policy "projects_update_members"
  on public.projects for update
  using (
    (org_id is not null and private.is_member(org_id) and not private.is_org_suspended(org_id) and (private.is_admin(org_id) or private.is_project_member(id)))
    or (org_id is null and owner_id = auth.uid())
  )
  with check (
    (org_id is not null and private.is_member(org_id) and not private.is_org_suspended(org_id) and (private.is_admin(org_id) or private.is_project_member(id)))
    or (org_id is null and owner_id = auth.uid())
  );

-- --- projects_delete_members -----------------------------------------------
-- Before (0046_org_suspension.sql:126-132):
--   using (
--     (org_id is not null and private.is_member(org_id) and not private.is_org_suspended(org_id))
--     or (org_id is null and owner_id = auth.uid())
--   );
drop policy "projects_delete_members" on public.projects;
create policy "projects_delete_members"
  on public.projects for delete
  using (
    (org_id is not null and private.is_member(org_id) and not private.is_org_suspended(org_id) and (private.is_admin(org_id) or private.is_project_member(id)))
    or (org_id is null and owner_id = auth.uid())
  );

-- =========================================================================
-- 5. Creator auto-membership trigger
-- =========================================================================

create or replace function private.add_creator_as_project_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.project_members (project_id, user_id)
  values (new.id, new.created_by)
  on conflict (project_id, user_id) do nothing;
  return new;
end;
$$;

revoke execute on function private.add_creator_as_project_member() from public, anon, authenticated;

create trigger projects_add_creator_as_member
  after insert on public.projects
  for each row
  execute function private.add_creator_as_project_member();

-- =========================================================================
-- 6. Grandfathering backfill — see header comment for why this is every
--    current org member, not just each project's own creator.
-- =========================================================================

insert into public.project_members (project_id, user_id)
select p.id, om.user_id
from public.projects p
join public.organization_members om on om.org_id = p.org_id
where p.org_id is not null
on conflict (project_id, user_id) do nothing;

insert into public.project_members (project_id, user_id)
select p.id, p.owner_id
from public.projects p
where p.org_id is null
on conflict (project_id, user_id) do nothing;
